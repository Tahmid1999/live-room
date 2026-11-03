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
import { Engine, Gift, Guest, Room } from '@prisma/client';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { Clock, CLOCK } from '../clock';
import { MAX_REPORT_BPS } from '../egress/rate';
import { recordReport } from '../egress/reports';
import { EventsService } from '../events/events.service';
import { GuestsService } from '../guests/guests.service';
import { hit } from '../limits';
import { markPresent, viewerCount } from '../presence';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';
import { REPLICA } from '../replica';
import { hasJoined, markJoined } from '../rooms/joined';
import { RoomsService } from '../rooms/rooms.service';
import { tapLabel } from '../wallet/gifts';
import { cleanChat } from './chat';
import { LeaderboardService } from './leaderboard.service';

type SocketData = { guest: Guest; roomId?: string; engine?: Engine };
type RoomSocket = Socket<any, any, any, SocketData>;

type GiftCommitted = { gift: Gift; guest: Guest; room: Room; lockMs: number; txMs: number };

const HISTORY = 50;
const CHAT_TTL_SEC = 24 * 3600;

// How long this process trusts that a room is still live. A kill on this
// replica clears it at once; another replica's sockets are taken out of the
// room by the kill itself, so the cache only decides for the window after.
const LIVE_CACHE_MS = 1000;

// An honest phone sends a join, a report every 5 s and at most a chat line a
// second; 30 in 10 s is room for all of that, and a loop is cut off.
const EVENT_BUDGET = 30;
const BUDGET_WINDOW_MS = 10_000;
// A phone and two spare tabs.
const SOCKETS_PER_GUEST = 3;
// A claim older than this is pruned, so a crashed replica's claims block for
// at most this long. A handshake that outlives its claim is refused, because
// by then another handshake may have pruned it and not counted it.
const CLAIM_MS = 30_000;

const roomName = (roomId: string) => `room:${roomId}`;
const guestRoom = (guestId: string) => `guest:${guestId}`;
const claimsKey = (guestId: string) => `sockets:claims:${guestId}`;

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
  private readonly liveUntil = new Map<string, number>();
  // Claims of this process's handshakes, by socket id, until each joins or closes.
  private readonly claimDrops = new Map<string, () => Promise<number>>();

  @WebSocketServer() private server: Server;

  constructor(
    private readonly guests: GuestsService,
    private readonly rooms: RoomsService,
    private readonly board: LeaderboardService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inflight: Inflight,
    private readonly hood: EventsService,
    @Inject(REPLICA) private readonly replica: string,
  ) {}

  afterInit(server: Server) {
    // Middleware rather than handleConnection: the client may emit room:join
    // the moment it sees "connect", so the guest has to be resolved before that.
    server.use(async (socket: RoomSocket, next) => {
      // Socket.IO ignores this promise, so a rejection has to reach next().
      try {
        const guest = await this.guests.fromCookieHeader(socket.handshake.headers.cookie);
        if (!guest) return next(new Error('no guest'));
        // fetchSockets cannot see a handshake still in flight, so each one
        // first claims a place in a shared set, kept until its socket has
        // joined. The last to claim counts every other admitted socket, so a
        // burst may be refused with room left but cannot race past the cap.
        // (A replica whose adapter link is down drops out of fetchSockets;
        // the cap is abuse control, not an exact count.)
        const key = claimsKey(guest.id);
        const now = Date.now();
        const replies = await this.redis
          .multi()
          .zremrangebyscore(key, '-inf', now - CLAIM_MS)
          .zadd(key, now, socket.id)
          .zcard(key)
          .pexpire(key, CLAIM_MS)
          .exec();
        // A transport that closes before 'connection' gets neither that event
        // nor 'disconnect'; without this its claim would hold a place for 30 s.
        const onClose = () => this.inflight.track(dropClaim());
        const dropClaim = () => {
          socket.conn.off('close', onClose);
          this.claimDrops.delete(socket.id);
          return this.redis.zrem(key, socket.id);
        };
        socket.conn.once('close', onClose);
        this.claimDrops.set(socket.id, dropClaim);
        // Closed while the guest was being looked up: the listener came too late.
        if (socket.conn.readyState !== 'open') {
          await dropClaim();
          return next(new Error('closed'));
        }
        let counted: number;
        try {
          const [err, claims] = replies![2];
          if (err) throw err;
          // Asked through the adapter, so the count covers every replica.
          counted = (await server.in(guestRoom(guest.id)).fetchSockets()).length + (claims as number);
        } catch (err) {
          await dropClaim();
          throw err;
        }
        if (Date.now() - now >= CLAIM_MS) {
          await dropClaim();
          return next(new Error('handshake too slow'));
        }
        if (counted > SOCKETS_PER_GUEST) {
          await dropClaim();
          return next(new Error('too many connections'));
        }
        socket.data.guest = guest;
        next();
      } catch (err) {
        next(err as Error);
      }
    });
    server.on('connection', (socket: RoomSocket) => {
      const guestId = socket.data.guest.id;
      // Join before dropping the claim: in between the socket is counted
      // twice, never zero times.
      socket.join(guestRoom(guestId));
      const dropClaim = this.claimDrops.get(socket.id);
      if (dropClaim) this.inflight.track(dropClaim());
      let windowStart = Date.now();
      let used = 0;
      socket.use((_packet, next) => {
        const now = Date.now();
        if (now - windowStart >= BUDGET_WINDOW_MS) {
          windowStart = now;
          used = 0;
        }
        if (++used <= EVENT_BUDGET) return next();
        // Once: the socket is gone after this, and later packets in the same
        // read are dropped without a second line.
        if (socket.connected) this.hood.note('rate-limit', 'rate-limit socket events');
        socket.disconnect(true);
      });
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

  // Leaving the room on every replica is what stops a socket that ignores
  // room:killed: its chat and reports are checked against its rooms.
  closeRoom(roomId: string) {
    this.liveUntil.delete(roomId);
    if (this.closing) return;
    this.emitToRoom(roomId, 'room:killed', {});
    this.server.in(roomName(roomId)).socketsLeave(roomName(roomId));
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

    // The socket does not check the cap, the per-network allowance or the
    // Agora pause, so it only admits someone who passed them over HTTP.
    if (!(await hasJoined(this.redis, room.id, socket.data.guest.id, this.clock.now()))) {
      throw new WsException({ error: 'join the room first' });
    }

    if (socket.data.roomId && socket.data.roomId !== room.id) await this.leave(socket);
    socket.data.roomId = room.id;
    socket.data.engine = room.engine;
    await socket.join(roomName(room.id));
    await markPresent(this.redis, room.id, socket.data.guest.id, this.clock.now());
    await this.broadcastViewers(room.id);

    // Before the history, so a client that has the history also has the top 5.
    socket.emit('lb', { top: await this.board.top(room.id) });

    const stored = await this.redis.lrange(`chat:${room.id}`, 0, HISTORY - 1);
    // LPUSH keeps the newest first; the client wants them in reading order.
    socket.emit('chat:history', { items: stored.reverse().map((s) => JSON.parse(s)) });
  }

  @SubscribeMessage('room:leave')
  async leave(@ConnectedSocket() socket: RoomSocket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.data.roomId = undefined;
    socket.data.engine = undefined;
    await socket.leave(roomName(roomId));
    await this.dropViewer(roomId, socket.data.guest.id);
  }

  @SubscribeMessage('stats')
  async stats(@ConnectedSocket() socket: RoomSocket, @MessageBody() body: { bps?: unknown }) {
    const { guest, roomId } = socket.data;
    if (!roomId || typeof body?.bps !== 'number' || !Number.isFinite(body.bps)) return;
    if (!(await this.stillIn(socket, roomId))) return;
    const engine = socket.data.engine!;
    const bps = Math.round(Math.min(Math.max(body.bps, 0), MAX_REPORT_BPS[engine]));

    // Tracked because this is Redis work that a closing server may cut off
    // halfway; shutdown waits for it before quitting the connection.
    const work = this.recordStats(guest.id, roomId, bps);
    this.inflight.track(work);
    await work;
  }

  @SubscribeMessage('chat:send')
  async chat(@ConnectedSocket() socket: RoomSocket, @MessageBody() body: { text?: unknown }) {
    const { guest, roomId } = socket.data;
    if (!roomId || typeof body?.text !== 'string') return;
    if (!(await this.stillIn(socket, roomId))) throw new WsException({ error: 'room has ended' });

    // Limit first: every message costs a slot, so junk cannot be retried for free.
    // Its own prefix: chat:<id> is a room's history.
    if (!(await hit(this.redis, `chatrate:${guest.id}`, 1, 1))) {
      this.hood.note('rate-limit', 'rate-limit chat');
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
  // reports again (its stats heartbeat), which is a few seconds of undercount.
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
  onGiftCommitted(committed: GiftCommitted) {
    this.inflight.track(this.fanOutGift(committed));
  }

  private async fanOutGift({ gift, guest, room, lockMs, txMs }: GiftCommitted) {
    try {
      this.emitToRoom(room.id, 'gift', {
        name: guest.name,
        giftId: gift.giftId,
        coins: gift.coins,
        at: gift.createdAt.getTime(),
      });
      await this.board.add(room.id, guest.id, gift.coins);
      await this.pushLeaderboard(room.id);
      // Last, so a slow or failed socket count cannot hold back the standings.
      // Skipped once shutdown has begun: the sockets are gone and the adapter's
      // connections may be closing, so there is no count to show.
      if (this.closing) return;
      const sockets = await this.socketCount(room.id);
      this.hood.emit({
        t: this.clock.now(),
        kind: 'gift',
        replica: this.replica,
        text: `gift ${tapLabel(gift.tapId)} · lock ${Math.round(lockMs)} ms · tx ${Math.round(txMs)} ms · ${this.replica} · fan-out ${sockets} sockets`,
      });
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

  private async recordStats(guestId: string, roomId: string, bps: number) {
    // Clients report every 5 s; one per 2 s leaves room for jitter and stops a
    // loop from turning every emit into Redis writes.
    if (!(await hit(this.redis, `stats:${guestId}`, 1, 2))) return;
    const now = this.clock.now();
    await recordReport(this.redis, roomId, guestId, bps, now);
    // A viewer who is watching keeps their place: LiveKit refreshes its own
    // token, so an audio viewer never calls /renew, and a reconnect after a
    // network blip must not be refused for having sat quietly past the marker.
    if (await hasJoined(this.redis, roomId, guestId, now)) {
      await markJoined(this.redis, roomId, guestId, now);
    }
  }

  private async stillIn(socket: RoomSocket, roomId: string) {
    if (!socket.rooms.has(roomName(roomId))) return false;
    if ((this.liveUntil.get(roomId) ?? 0) > Date.now()) return true;
    const live = await this.rooms.isLive(roomId);
    if (live) this.liveUntil.set(roomId, Date.now() + LIVE_CACHE_MS);
    else this.liveUntil.delete(roomId);
    return live;
  }

  private async dropViewer(roomId: string, guestId: string) {
    // Both, so the viewer count and the egress sum agree from the moment
    // someone leaves instead of 15 s later.
    await this.redis.multi().zrem(`viewers:${roomId}`, guestId).hdel(`eg:${roomId}`, guestId).exec();
    await this.broadcastViewers(roomId);
  }

  private async broadcastViewers(roomId: string) {
    if (this.closing) return;
    const count = await viewerCount(this.redis, roomId, this.clock.now());
    this.emitToRoom(roomId, 'viewers', { count });
  }
}
