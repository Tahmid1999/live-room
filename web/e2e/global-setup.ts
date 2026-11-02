import { execSync } from 'node:child_process';
import path from 'node:path';
import Redis from 'ioredis';

// The dev API's per-IP limits (5 new guests and 12 joins an hour) would stop
// the second run of the day. Only those counters are deleted.
export default async function globalSetup() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6383/0');
  for (const pattern of ['guestnew:*', 'joins:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
  await redis.quit();

  execSync('npm run seed', { cwd: path.resolve(__dirname, '..', '..', 'api'), stdio: 'ignore' });
}
