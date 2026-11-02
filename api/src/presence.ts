import Redis from 'ioredis';

// A viewer is whoever reported in the last 15 s, so a phone that dies without
// closing the socket drops out on its own.
const PRESENT_MS = 15000;

export async function markPresent(redis: Redis, roomId: string, guestId: string, now: number) {
  const key = `viewers:${roomId}`;
  // Pruning on write keeps the set from growing with every guest the room ever had.
  await redis
    .multi()
    .zadd(key, now, guestId)
    .zremrangebyscore(key, '-inf', now - PRESENT_MS)
    .exec();
}

export function viewerCount(redis: Redis, roomId: string, now: number): Promise<number> {
  return redis.zcount(`viewers:${roomId}`, `(${now - PRESENT_MS}`, '+inf');
}
