import {
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Guest, Room, RoomKind } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Clock, CLOCK } from '../clock';
import { TransferBudget } from '../egress/transfer-budget';
import { EventsService } from '../events/events.service';
import { hashIp } from '../guests/guests.service';
import { hit } from '../limits';
import { isPresent, viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';
import { hasJoined, markJoined } from './joined';
import { mintLiveKitHost, mintLiveKitViewer } from './tokens';

export type RoomCard = {
  id: string;
  kind: Room['kind'];
  title: string;
  hostName: string;
  house: boolean;
  viewers: number;
  startsOnOpen: boolean;
};

export type JoinInfo = {
  kind: RoomKind;
  url: string;
  room: string;
  identity: string;
  token: string;
};

// Video is what the node's transfer budget pays for, so it gets the smaller room.
const MAX_VIEWERS: Record<RoomKind, number> = { VIDEO: 20, AUDIO: 50 };
const JOINS_PER_IP = 12;
const RENEWS_PER_HOUR = 12;
// Six ten-minute renewals: an hour of video a day per guest without a fresh
// join. A tab left open all night would otherwise keep the node sending; the
// fresh join it has to make instead counts against the per-network allowance.
const VIDEO_RENEWS_PER_DAY = 6;
const DAY_MS = 24 * 3600 * 1000;
const HOUSE_IDENTITY = 'house';
// The house stream runs unattended, so its token has to outlast a session
// instead of kicking it every ten minutes.
const HOST_TTL_SEC = 6 * 3600;
const HOUSE_ON_TTL_SEC = 30;
const OBJECT_ID = /^[0-9a-f]{24}$/;

// Rolling window in one script, so two tabs renewing at once cannot both take
// the sixth slot.
const TAKE_RENEWAL = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

@Injectable()
export class RoomsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly budget: TransferBudget,
    private readonly config: ConfigService,
    private readonly hood: EventsService,
  ) {
    this.secret = config.getOrThrow('COOKIE_SECRET');
  }

  async list(): Promise<RoomCard[]> {
    const rooms = await this.prisma.room.findMany({
      where: { status: 'LIVE' },
      orderBy: { createdAt: 'asc' },
    });
    const now = this.clock.now();
    return Promise.all(
      rooms.map(async (r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        hostName: r.hostName,
        house: r.house,
        viewers: await viewerCount(this.redis, r.id, now),
        startsOnOpen: r.house && r.kind === 'VIDEO',
      })),
    );
  }

  async join(roomId: string, guest: Guest, ip: string): Promise<JoinInfo> {
    const room = await this.liveRoom(roomId).catch((err) => {
      if (err instanceof GoneException) this.hood.note('join-refused', 'refused join · room ended');
      throw err;
    });
    if (room.kind === 'VIDEO' && (await this.budget.isVideoPaused())) {
      this.hood.note('join-refused', 'refused join · video paused');
      throw new HttpException(
        { error: 'video paused until the 1st: monthly transfer budget 80% used' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const now = this.clock.now();
    // Someone who already holds a place (a reconnect, a second tab) is not
    // one over the cap, so a full room must not lock them out of their own seat.
    if (
      (await viewerCount(this.redis, room.id, now)) >= MAX_VIEWERS[room.kind] &&
      !(await isPresent(this.redis, room.id, guest.id, now))
    ) {
      this.hood.note('join-refused', 'refused join · room full');
      throw new HttpException({ error: 'room is full' }, HttpStatus.CONFLICT);
    }
    // Counted only once the room would let them in, so a full or paused room
    // does not eat into the hourly allowance.
    const key = `joins:${hashIp(ip, this.secret)}`;
    if (!(await hit(this.redis, key, JOINS_PER_IP, 3600))) {
      this.hood.note('join-refused', 'refused join · rate limit');
      throw new HttpException(
        { error: 'too many joins from this network, try in an hour' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const info = await this.mint(room, guest);
    await markJoined(this.redis, room.id, guest.id, this.clock.now());
    // After the mint: a join that failed to get a token is not a join.
    this.hood.note('join', `join ${room.kind.toLowerCase()} room`);
    return info;
  }

  // Same shape for a first join and a renewal, so the client swaps tokens
  // without caring which one it got.
  private async mint(room: Room, guest: Guest): Promise<JoinInfo> {
    return {
      kind: room.kind,
      url: this.config.getOrThrow('LIVEKIT_URL'),
      room: room.id,
      identity: guest.id,
      token: await mintLiveKitViewer(room.id, guest.id),
    };
  }

  // Viewer tokens last ten minutes and a stream outlives that. Only someone
  // whose heartbeat is fresh gets a new one, and it skips the per-network join
  // allowance because it is not a new seat; a per-guest cap stands in for it.
  async renew(roomId: string, guest: Guest): Promise<JoinInfo> {
    const room = await this.liveRoom(roomId);
    if (room.kind === 'VIDEO' && (await this.budget.isVideoPaused())) {
      throw new HttpException(
        { error: 'video paused until the 1st: monthly transfer budget 80% used' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const now = this.clock.now();
    if (
      !(await isPresent(this.redis, room.id, guest.id, now)) ||
      !(await hasJoined(this.redis, room.id, guest.id, now))
    ) {
      throw new HttpException({ error: 'not in this room' }, HttpStatus.FORBIDDEN);
    }
    if (!(await hit(this.redis, `renew:${guest.id}`, RENEWS_PER_HOUR, 3600))) {
      throw new HttpException({ error: 'too many renewals' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (room.kind === 'VIDEO' && !(await this.takeVideoRenewal(guest.id, now))) {
      throw new HttpException({ error: 'still watching? reopen the room' }, HttpStatus.FORBIDDEN);
    }
    const info = await this.mint(room, guest);
    await markJoined(this.redis, room.id, guest.id, now);
    return info;
  }

  private async takeVideoRenewal(guestId: string, now: number): Promise<boolean> {
    const taken = await this.redis.eval(
      TAKE_RENEWAL,
      1,
      `renewvideo:${guestId}`,
      now - DAY_MS,
      now,
      VIDEO_RENEWS_PER_DAY,
      randomUUID(),
      DAY_MS,
    );
    return taken === 1;
  }

  async houseToken(roomId: string): Promise<JoinInfo> {
    const room = await this.liveRoom(roomId);
    if (!room.house) throw new NotFoundException({ error: 'not a house room' });
    return {
      kind: room.kind,
      url: this.config.getOrThrow('LIVEKIT_URL'),
      room: room.id,
      identity: HOUSE_IDENTITY,
      token: await mintLiveKitHost(room.id, HOUSE_IDENTITY, HOST_TTL_SEC),
    };
  }

  // The worker re-sends 'publishing' every 10 s, so the key lapses within 30 s
  // if the worker dies without saying 'stopped', so a host that is gone does
  // not read as publishing. Only the transition is worth a hood line.
  async houseEvent(roomId: string, state: 'publishing' | 'stopped') {
    const room = await this.liveRoom(roomId);
    if (!room.house) throw new NotFoundException({ error: 'not a house room' });
    const key = `house:on:${room.id}`;
    const changed =
      state === 'publishing'
        ? (await this.redis.set(key, '1', 'EX', HOUSE_ON_TTL_SEC, 'GET')) === null
        : (await this.redis.del(key)) > 0;
    if (changed) this.hood.note('house', `house ${room.kind.toLowerCase()} room · ${state}`);
  }

  async isLive(roomId: string): Promise<boolean> {
    const room = await this.prisma.room.findUnique({ where: { id: roomId }, select: { status: true } });
    return room?.status === 'LIVE';
  }

  async liveRoom(roomId: string): Promise<Room> {
    const room = OBJECT_ID.test(roomId)
      ? await this.prisma.room.findUnique({ where: { id: roomId } })
      : null;
    if (!room) throw new NotFoundException({ error: 'no such room' });
    if (room.status !== 'LIVE') throw new GoneException({ error: 'room has ended' });
    return room;
  }
}
