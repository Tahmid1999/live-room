import { Engine } from '@prisma/client';
import Redis from 'ioredis';
import { markPresent, PRESENT_MS } from '../presence';

// A viewer who stops reporting leaves a field behind; the key lapses a minute
// after the room's last report so an ended room does not keep its hash.
const HASH_TTL_SEC = 60;

// Every report is also the viewer's heartbeat, which is why presence is
// refreshed here and a phone that goes quiet drops out after 15 s.
export async function recordReport(
  redis: Redis,
  roomId: string,
  engine: Engine,
  guestId: string,
  bps: number,
  now: number,
) {
  await markPresent(redis, roomId, guestId, now);
  const key = `eg:${roomId}`;
  await redis
    .multi()
    .hset(key, guestId, `${bps}|${now}`)
    .expire(key, HASH_TTL_SEC)
    .set(`eg:last:${engine}`, bps)
    .exec();
}

export async function roomEgress(redis: Redis, roomId: string, now: number) {
  const key = `eg:${roomId}`;
  const reports = await redis.hgetall(key);
  const stale: string[] = [];
  let viewers = 0;
  let totalBps = 0;
  for (const [guestId, value] of Object.entries(reports)) {
    const [bps, at] = value.split('|').map(Number);
    if (now - at < PRESENT_MS) {
      viewers += 1;
      totalBps += bps;
    } else {
      stale.push(guestId);
    }
  }
  // Pruned on read: the sampler visits every live room every 10 s, so the
  // hash cannot grow with the guests a busy room has had.
  if (stale.length) await redis.hdel(key, ...stale);
  return { viewers, perViewerBps: viewers ? totalBps / viewers : 0, totalBps };
}
