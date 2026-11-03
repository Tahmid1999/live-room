import Redis from 'ioredis';

// The dev API's per-IP limits (5 new guests, 12 joins and 5 admin logins an
// hour) would stop a run partway through: every test starts a fresh guest.
// Only those counters are deleted.
export async function clearIpLimits() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6383/0');
  for (const pattern of ['guestnew:*', 'joins:*', 'adminlogin:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
  await redis.quit();
}
