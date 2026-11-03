import {
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Guest, Room } from '@prisma/client';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { AgoraMinutes } from '../egress/agora-minutes';
import { EventsService } from '../events/events.service';
import { hashIp } from '../guests/guests.service';
import { hit } from '../limits';
import { isPresent, viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';
import { hasJoined, markJoined } from './joined';
import {
  agoraUidFor,
  mintAgoraHost,
  mintAgoraViewer,
  mintLiveKitHost,
  mintLiveKitViewer,
} from './tokens';

export type RoomCard = {
  id: string;
  kind: Room['kind'];
  engine: Room['engine'];
  title: string;
  hostName: string;
  house: boolean;
  viewers: number;
  startsOnOpen: boolean;
};

export type JoinInfo =
  | { engine: 'agora'; appId: string; channel: string; uid: number; token: string }
  | { engine: 'livekit'; url: string; room: string; identity: string; token: string };

const MAX_VIEWERS = 50;
const JOINS_PER_IP = 12;
const RENEWS_PER_HOUR = 12;
const HOUSE_UID = 1;
const HOUSE_IDENTITY = 'house';
// The house stream runs unattended, so its token has to outlast a session
// instead of kicking it every ten minutes.
const HOST_TTL_SEC = 6 * 3600;
const HOUSE_ON_TTL_SEC = 30;
const OBJECT_ID = /^[0-9a-f]{24}$/;

@Injectable()
export class RoomsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly minutes: AgoraMinutes,
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
        engine: r.engine,
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
    if (room.engine === 'agora' && (await this.minutes.isAgoraPaused())) {
      this.hood.note('join-refused', 'refused join · video paused');
      throw new HttpException(
        { error: 'video paused until the 1st: free Agora minutes used up' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const now = this.clock.now();
    // Someone who already holds a place (a reconnect, a second tab) is not
    // a 51st viewer, so a full room must not lock them out of their own seat.
    if (
      (await viewerCount(this.redis, room.id, now)) >= MAX_VIEWERS &&
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
    this.hood.note('engine', `join ${room.kind.toLowerCase()} room · engine ${room.engine}`);
    return info;
  }

  // Same shape for a first join and a renewal, so the client swaps tokens
  // without caring which one it got.
  private async mint(room: Room, guest: Guest): Promise<JoinInfo> {
    if (room.engine === 'agora') {
      const uid = agoraUidFor(guest.id);
      return {
        engine: 'agora',
        appId: process.env.AGORA_APP_ID!,
        channel: room.id,
        uid,
        token: mintAgoraViewer(room.id, uid),
      };
    }
    return {
      engine: 'livekit',
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
    if (room.engine === 'agora' && (await this.minutes.isAgoraPaused())) {
      throw new HttpException(
        { error: 'video paused until the 1st: free Agora minutes used up' },
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
    const info = await this.mint(room, guest);
    await markJoined(this.redis, room.id, guest.id, now);
    return info;
  }

  async houseToken(roomId: string): Promise<JoinInfo> {
    const room = await this.liveRoom(roomId);
    if (!room.house) throw new NotFoundException({ error: 'not a house room' });
    if (room.engine === 'agora') {
      return {
        engine: 'agora',
        appId: process.env.AGORA_APP_ID!,
        channel: room.id,
        uid: HOUSE_UID,
        token: mintAgoraHost(room.id, HOUSE_UID, HOST_TTL_SEC),
      };
    }
    return {
      engine: 'livekit',
      url: this.config.getOrThrow('LIVEKIT_URL'),
      room: room.id,
      identity: HOUSE_IDENTITY,
      token: await mintLiveKitHost(room.id, HOUSE_IDENTITY, HOST_TTL_SEC),
    };
  }

  // The worker re-sends 'publishing' every 10 s, so the key lapses within 30 s
  // if the worker dies without saying 'stopped'; the Agora minute count never
  // bills a host that is gone. Only the transition is worth a hood line.
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
