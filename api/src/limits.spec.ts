import Redis from 'ioredis';
import { hit } from './limits';

describe('hit', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL_TEST!);
  });

  beforeEach(() => redis.flushdb());

  afterAll(() => redis.quit());

  it('allows max hits then refuses within the window', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await hit(redis, 'k', 5, 60)).toBe(true);
    }
    expect(await hit(redis, 'k', 5, 60)).toBe(false);
  });

  it('allows again once the window has passed', async () => {
    for (let i = 0; i < 5; i++) await hit(redis, 'k', 5, 1);
    expect(await hit(redis, 'k', 5, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await hit(redis, 'k', 5, 1)).toBe(true);
  });

  it('counts keys separately', async () => {
    for (let i = 0; i < 5; i++) await hit(redis, 'a', 5, 60);
    expect(await hit(redis, 'b', 5, 60)).toBe(true);
  });
});
