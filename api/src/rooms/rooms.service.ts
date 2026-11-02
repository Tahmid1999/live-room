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
import { hashIp } from '../guests/guests.service';
import { hit } from '../limits';
import { markPresent, viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';
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
const HOUSE_UID = 1;
const HOUSE_IDENTITY = 'house';
// The house stream runs unattended, so its token has to outlast a session
// instead of kicking it every ten minutes.
const HOST_TTL_SEC = 6 * 3600;
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
    const room = await this.liveRoom(roomId);
    if (room.engine === 'agora' && (await this.minutes.isAgoraPaused())) {
      throw new HttpException(
        { error: 'video paused until the 1st: free Agora minutes used up' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if ((await viewerCount(this.redis, room.id, this.clock.now())) >= MAX_VIEWERS) {
      throw new HttpException({ error: 'room is full' }, HttpStatus.CONFLICT);
    }
    // Counted only once the room would let them in, so a full or paused room
    // does not eat into the hourly allowance.
    const key = `joins:${hashIp(ip, this.secret)}`;
    if (!(await hit(this.redis, key, JOINS_PER_IP, 3600))) {
      throw new HttpException(
        { error: 'too many joins from this network, try in an hour' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

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

  async liveRoom(roomId: string): Promise<Room> {
    const room = OBJECT_ID.test(roomId)
      ? await this.prisma.room.findUnique({ where: { id: roomId } })
      : null;
    if (!room) throw new NotFoundException({ error: 'no such room' });
    if (room.status !== 'LIVE') throw new GoneException({ error: 'room has ended' });
    return room;
  }
}
