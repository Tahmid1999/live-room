import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Guest, Prisma } from '@prisma/client';
import { parse } from 'cookie';
import { signedCookie } from 'cookie-parser';
import { createHash, randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { EventsService } from '../events/events.service';
import { hit } from '../limits';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';

export const GUEST_COOKIE = 'lr_guest';
const OBJECT_ID = /^[0-9a-f]{24}$/;
const START_BALANCE = 1000;
const NEW_GUESTS_PER_IP = 5;

export function hashIp(ip: string, secret: string): string {
  return createHash('sha256').update(ip + secret).digest('hex');
}

@Injectable()
export class GuestsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly hood: EventsService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow('COOKIE_SECRET');
  }

  // Takes the raw header so the socket handshake can use it too; cookie-parser
  // only runs on Express requests.
  async fromCookieHeader(cookieHeader?: string): Promise<Guest | null> {
    const raw = parse(cookieHeader ?? '')[GUEST_COOKIE];
    if (!raw) return null;
    // signedCookie() hands back an unprefixed value unchanged, so the s: check
    // is what stops a bare guest id from passing as a signed cookie.
    if (!raw.startsWith('s:')) return null;
    const id = signedCookie(raw, this.secret);
    if (id === false || !OBJECT_ID.test(id)) return null;
    return this.prisma.guest.findUnique({ where: { id } });
  }

  async create(ip: string): Promise<Guest> {
    const ipHash = hashIp(ip, this.secret);
    if (!(await hit(this.redis, `guestnew:${ipHash}`, NEW_GUESTS_PER_IP, 3600))) {
      this.hood.note('rate-limit', 'rate-limit new guest');
      throw new HttpException(
        { error: 'too many new guests from this network, try in an hour' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // 10k names and a unique index: a clash is rare early on, so retry rather than check first
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = `guest-${String(randomInt(10000)).padStart(4, '0')}`;
      try {
        return await this.prisma.guest.create({
          data: { name, ipHash, balance: START_BALANCE },
        });
      } catch (err) {
        const clash =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!clash) throw err;
      }
    }
    throw new HttpException('no free guest name', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
