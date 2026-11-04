import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { REDIS } from '../redis/redis.module';

const PAUSE_AT = 0.8;
const TB = 1e12;
// Long enough to read last month's number on the 1st, short enough that old
// months do not pile up.
const KEEP_SEC = 40 * 86400;
const AT_KEY = 'eg:month:at';

// UTC calendar month: the host's transfer allowance is billed on its own
// calendar, and one timezone keeps every replica on the same key.
const monthKey = (now: number) => `eg:month:${new Date(now).toISOString().slice(0, 7)}`;

export type TransferUsage = {
  usedBytes: number;
  budgetBytes: number;
  pauseAtBytes: number;
  paused: boolean;
  // When bytes were last added, so a page can tell a quiet month from a
  // sampler that has stopped reading the node.
  measuredAt: number | null;
};

@Injectable()
export class TransferBudget {
  private readonly budgetBytes: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.budgetBytes = Number(config.getOrThrow('BUDGET_TB_MONTH')) * TB;
  }

  async add(bytes: number) {
    // INCRBY takes whole numbers only, and a parsed counter can carry a fraction.
    const whole = Math.round(bytes);
    if (!Number.isFinite(whole) || whole <= 0) return;
    const now = this.clock.now();
    const key = monthKey(now);
    await this.redis
      .multi()
      .incrby(key, whole)
      .expire(key, KEEP_SEC)
      .set(AT_KEY, String(now), 'EX', KEEP_SEC)
      .exec();
  }

  async usage(): Promise<TransferUsage> {
    const [used, at] = await this.redis.mget(monthKey(this.clock.now()), AT_KEY);
    const usedBytes = Number(used) || 0;
    // Whole bytes: the counter is an integer, so >= 80.4 and >= 81 say the same.
    const pauseAtBytes = Math.ceil(PAUSE_AT * this.budgetBytes);
    return {
      usedBytes,
      budgetBytes: this.budgetBytes,
      pauseAtBytes,
      paused: usedBytes >= pauseAtBytes,
      measuredAt: at === null ? null : Number(at),
    };
  }

  async isVideoPaused() {
    return (await this.usage()).paused;
  }
}
