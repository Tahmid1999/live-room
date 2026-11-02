import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Guest, Prisma } from '@prisma/client';
import { parse } from 'cookie';
import { signedCookie } from 'cookie-parser';
import { createHash, randomInt } from 'node:crypto';
import Redis from 'ioredis';
import { hit } from '../limits';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';

export const GUEST_COOKIE = 'lr_guest';
const START_BALANCE = 1000;
const NEW_GUESTS_PER_IP = 5;

@Injectable()
export class GuestsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow('COOKIE_SECRET');
  }

  // Takes the raw header so the socket handshake can use it too; cookie-parser
  // only runs on Express requests.
  async fromCookieHeader(cookieHeader?: string): Promise<Guest | null> {
    const raw = parse(cookieHeader ?? '')[GUEST_COOKIE];
    if (!raw) return null;
    const id = signedCookie(raw, this.secret);
    if (id === false) return null;
    return this.prisma.guest.findUnique({ where: { id } });
  }

  async create(ip: string): Promise<Guest> {
    const ipHash = createHash('sha256').update(ip + this.secret).digest('hex');
    if (!(await hit(this.redis, `guestnew:${ipHash}`, NEW_GUESTS_PER_IP, 3600))) {
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
