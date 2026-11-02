import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { REDIS } from '../redis/redis.module';

const PAUSE_AT = 0.8;
// Long enough to read last month's number on the 1st, short enough that old
// months do not pile up.
const KEEP_SEC = 40 * 86400;

// UTC, because Agora's free tier resets on its own calendar, not ours.
const monthKey = (now: number) => `agora:min:${new Date(now).toISOString().slice(0, 7)}`;

@Injectable()
export class AgoraMinutes {
  private readonly free: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.free = Number(config.getOrThrow('AGORA_FREE_MINUTES'));
  }

  async add(minutes: number) {
    const key = monthKey(this.clock.now());
    await this.redis.multi().incrby(key, minutes).expire(key, KEEP_SEC).exec();
  }

  async usage() {
    const used = Number(await this.redis.get(monthKey(this.clock.now()))) || 0;
    return { used, free: this.free, paused: used >= PAUSE_AT * this.free };
  }

  async isAgoraPaused() {
    return (await this.usage()).paused;
  }
}
