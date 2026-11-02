import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

const TTL_SEC = 24 * 3600;
const PUSH_GAP_MS = 1000;

export type LeaderboardRow = { name: string; coins: number };

@Injectable()
export class LeaderboardService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async add(roomId: string, name: string, coins: number) {
    const key = `lb:${roomId}`;
    await this.redis.multi().zincrby(key, coins, name).expire(key, TTL_SEC).exec();
  }

  async top(roomId: string, n = 5): Promise<LeaderboardRow[]> {
    const flat = await this.redis.zrevrange(`lb:${roomId}`, 0, n - 1, 'WITHSCORES');
    const rows: LeaderboardRow[] = [];
    for (let i = 0; i < flat.length; i += 2) rows.push({ name: flat[i], coins: Number(flat[i + 1]) });
    return rows;
  }

  // The gate lives in Redis so two replicas that both see a gift do not both push.
  async claimPush(roomId: string): Promise<boolean> {
    return (await this.redis.set(`lbpush:${roomId}`, '1', 'PX', PUSH_GAP_MS, 'NX')) === 'OK';
  }

  async msUntilPush(roomId: string): Promise<number> {
    return Math.max(await this.redis.pttl(`lbpush:${roomId}`), 0);
  }
}
