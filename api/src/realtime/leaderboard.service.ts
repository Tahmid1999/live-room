import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';

const TTL_SEC = 24 * 3600;
const PUSH_GAP_MS = 1000;

export type LeaderboardRow = { name: string; coins: number };

// Scored by guest id, named at read: guest names are recycled once the old
// guest is purged, and a new guest-0042 must not inherit the old one's coins.
@Injectable()
export class LeaderboardService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  async add(roomId: string, guestId: string, coins: number) {
    const key = `lb:${roomId}`;
    await this.redis.multi().zincrby(key, coins, guestId).expire(key, TTL_SEC).exec();
  }

  async top(roomId: string, n = 5): Promise<LeaderboardRow[]> {
    const flat = await this.redis.zrevrange(`lb:${roomId}`, 0, n - 1, 'WITHSCORES');
    const ids: string[] = [];
    for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
    if (ids.length === 0) return [];
    const guests = await this.prisma.guest.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const names = new Map(guests.map((g) => [g.id, g.name]));
    const rows: LeaderboardRow[] = [];
    // A guest purged between the retention run and its ZREM has no name to show.
    for (let i = 0; i < flat.length; i += 2) {
      const name = names.get(flat[i]);
      if (name) rows.push({ name, coins: Number(flat[i + 1]) });
    }
    return rows;
  }

  async forget(roomIds: string[], guestIds: string[]) {
    if (guestIds.length === 0) return;
    const write = this.redis.multi();
    for (const roomId of roomIds) write.zrem(`lb:${roomId}`, ...guestIds);
    await write.exec();
  }

  // The gate lives in Redis so two replicas that both see a gift do not both push.
  async claimPush(roomId: string): Promise<boolean> {
    return (await this.redis.set(`lbpush:${roomId}`, '1', 'PX', PUSH_GAP_MS, 'NX')) === 'OK';
  }

  async msUntilPush(roomId: string): Promise<number> {
    return Math.max(await this.redis.pttl(`lbpush:${roomId}`), 0);
  }
}
