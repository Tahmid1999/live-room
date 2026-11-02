import { BeforeApplicationShutdown, HttpException, Inject, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Gift, Guest, Room } from '@prisma/client';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { Clock, CLOCK } from '../clock';
import { GuestsService } from '../guests/guests.service';
import { hit } from '../limits';
import { markPresent, viewerCount } from '../presence';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';
import { RoomsService } from '../rooms/rooms.service';
import { cleanChat } from './chat';
import { LeaderboardService } from './leaderboard.service';

type SocketData = { guest: Guest; roomId?: string };
type RoomSocket = Socket<any, any, any, SocketData>;

type GiftCommitted = { gift: Gift; guest: Guest; room: Room };

const HISTORY = 50;
const CHAT_TTL_SEC = 24 * 3600;

const roomName = (roomId: string) => `room:${roomId}`;

@WebSocketGateway()
export class RoomGateway implements OnGatewayDisconnect, BeforeApplicationShutdown {
  private readonly log = new Logger(RoomGateway.name);
  // One trailing push per room per process is enough: it reads the standings
  // when it fires, so it covers every gift that arrived while it waited.
  private readonly trailing = new Map<string, NodeJS.Timeout>();
  // Set once the adapter's pub/sub pair is about to close. Anything detached
  // that starts after this only touches Redis (the leaderboard count), which
  // stays open until it has finished; it no longer pushes to sockets.
  private closing = false;

  @WebSocketServer() private server: Server;

  constructor(
    private readonly guests: GuestsService,
    private readonly rooms: RoomsService,
    private readonly board: LeaderboardService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inflight: Inflight,
  ) {}

  afterInit(server: Server) {
    // Middleware rather than handleConnection: the client may emit room:join
    // the moment it sees "connect", so the guest has to be resolved before that.
    server.use(async (socket: RoomSocket, next) => {
      // Socket.IO ignores this promise, so a rejection has to reach next().
      try {
        const guest = await this.guests.fromCookieHeader(socket.handshake.headers.cookie);
        if (!guest) return next(new Error('no guest'));
        socket.data.guest = guest;
        next();
      } catch (err) {
        next(err as Error);
      }
    });
  }

  async beforeApplicationShutdown() {
    await this.inflight.settled();
    // From here nothing publishes: the adapter's pub/sub pair is closed next
    // and the adapter does not handle a publish on a closed connection.
    this.closing = true;
    this.trailing.forEach(clearTimeout);
  }

  emitToRoom(roomId: string, event: string, payload?: unknown) {
    if (this.closing) return;
    this.server.to(roomName(roomId)).emit(event, payload);
  }

  async socketCount(roomId: string): Promise<number> {
    return (await this.server.in(roomName(roomId)).fetchSockets()).length;
  }

  @SubscribeMessage('room:join')
  async join(@ConnectedSocket() socket: RoomSocket, @MessageBody() body: { roomId?: unknown }) {
    if (typeof body?.roomId !== 'string') throw new WsException('roomId is required');
    const room = await this.rooms.liveRoom(body.roomId).catch((err) => {
      if (err instanceof HttpException) throw new WsException(err.getResponse());
      throw err;
    });

    if (socket.data.roomId && socket.data.roomId !== room.id) await this.leave(socket);
    socket.data.roomId = room.id;
    await socket.join(roomName(room.id));
    await markPresent(this.redis, room.id, socket.data.guest.id, this.clock.now());
    await this.broadcastViewers(room.id);

    const stored = await this.redis.lrange(`chat:${room.id}`, 0, HISTORY - 1);
    // LPUSH keeps the newest first; the client wants them in reading order.
    socket.emit('chat:history', { items: stored.reverse().map((s) => JSON.parse(s)) });
  }

  @SubscribeMessage('room:leave')
  async leave(@ConnectedSocket() socket: RoomSocket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.data.roomId = undefined;
    await socket.leave(roomName(roomId));
    await this.dropViewer(roomId, socket.data.guest.id);
  }

  @SubscribeMessage('chat:send')
  async chat(@ConnectedSocket() socket: RoomSocket, @MessageBody() body: { text?: unknown }) {
    const { guest, roomId } = socket.data;
    if (!roomId || typeof body?.text !== 'string') return;

    // Limit first: every message costs a slot, so junk cannot be retried for free.
    if (!(await hit(this.redis, `chat:${guest.id}`, 1, 1))) {
      socket.emit('chat:rejected', { reason: 'slow-down' });
      return;
    }
    const cleaned = cleanChat(body.text);
    if (!cleaned.ok) {
      socket.emit('chat:rejected', { reason: cleaned.reason });
      return;
    }

    const message = { name: guest.name, text: cleaned.text, at: this.clock.now() };
    const key = `chat:${roomId}`;
    await this.redis
      .multi()
      .lpush(key, JSON.stringify(message))
      .ltrim(key, 0, HISTORY - 1)
      .expire(key, CHAT_TTL_SEC)
      .exec();
    this.emitToRoom(roomId, 'chat', message);
  }

  // Same guest in two tabs: closing one removes the entry until the other
  // reports again (Task 7 heartbeat), which is a few seconds of undercount.
  async handleDisconnect(socket: RoomSocket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    await this.dropViewer(roomId, socket.data.guest.id).catch((err) => {
      // Socket.IO ignores this promise, so a Redis error (outage, failover)
      // has to end here or it becomes an unhandled rejection.
      this.log.warn(`viewer cleanup failed: ${err.message}`);
    });
  }

  // Runs after the gift is committed, so nothing in here may fail the request.
  @OnEvent('gift.committed')
  onGiftCommitted({ gift, guest, room }: GiftCommitted) {
    this.inflight.track(this.fanOutGift({ gift, guest, room }));
  }

  private async fanOutGift({ gift, guest, room }: GiftCommitted) {
    try {
      this.emitToRoom(room.id, 'gift', {
        name: guest.name,
        giftId: gift.giftId,
        coins: gift.coins,
        at: gift.createdAt.getTime(),
      });
      await this.board.add(room.id, guest.name, gift.coins);
      await this.pushLeaderboard(room.id);
    } catch (err) {
      this.log.error(`gift fan-out failed: ${(err as Error).message}`);
    }
  }

  private async pushLeaderboard(roomId: string) {
    if (this.closing) return;
    if (await this.board.claimPush(roomId)) {
      this.emitToRoom(roomId, 'lb', { top: await this.board.top(roomId) });
      return;
    }
    if (this.trailing.has(roomId)) return;
    const wait = await this.board.msUntilPush(roomId);
    // Concurrent gifts all pass the check above before any of them arms a
    // timer, so look again: an untracked timer cannot be cleared on shutdown.
    // This also covers a shutdown sweep that ran during the await.
    if (this.closing || this.trailing.has(roomId)) return;
    const timer = setTimeout(() => {
      this.trailing.delete(roomId);
      // If the claim fails, whoever holds the gate pushed after our gift was
      // stored, so their standings already include it.
      this.inflight.track(
        this.board
          .claimPush(roomId)
          .then(async (won) => {
            if (won) this.emitToRoom(roomId, 'lb', { top: await this.board.top(roomId) });
          })
          .catch((err) => this.log.error(`trailing lb push failed: ${err.message}`)),
      );
    }, wait + 5);
    timer.unref();
    this.trailing.set(roomId, timer);
  }

  private async dropViewer(roomId: string, guestId: string) {
    await this.redis.zrem(`viewers:${roomId}`, guestId);
    await this.broadcastViewers(roomId);
  }

  private async broadcastViewers(roomId: string) {
    if (this.closing) return;
    const count = await viewerCount(this.redis, roomId, this.clock.now());
    this.emitToRoom(roomId, 'viewers', { count });
  }
}
