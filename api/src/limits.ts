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
  // ttl -1 on a later hit means a crash between INCR and EXPIRE left the key
  // immortal; heal it here or the caller would be blocked forever.
  if (count === 1 || (await redis.ttl(key)) === -1) await redis.expire(key, windowSec);
  return count <= max;
}
