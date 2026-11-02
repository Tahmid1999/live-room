import Redis from 'ioredis';

// Fixed window. INCR, not GET-then-SET, so concurrent hits cannot both read
// the old count and slip past the limit.
export async function hit(
  redis: Redis,
  key: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count <= max;
}
