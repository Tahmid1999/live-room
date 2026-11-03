import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { bootApp, flushRedis, resetDb } from './helpers';

describe('guests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('creates a guest with 1000 coins and sets a signed cookie', async () => {
    const res = await request(server()).get('/me').expect(200);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      name: expect.stringMatching(/^guest-\d{4}$/),
      balance: 1000,
    });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^lr_guest=s%3A/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=86400');
  });

  it('returns the same guest for the same cookie', async () => {
    const first = await request(server()).get('/me');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const second = await request(server()).get('/me').set('Cookie', cookie).expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(await prisma.guest.count()).toBe(1);
  });

  it('stores a hash of the ip, never the ip', async () => {
    await request(server()).get('/me');
    const [guest] = await prisma.guest.findMany();
    expect(guest.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(guest)).not.toContain('127.0.0.1');
  });

  it('replaces a tampered cookie with a new guest', async () => {
    const first = await request(server()).get('/me');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const res = await request(server()).get('/me').set('Cookie', cookie + 'x').expect(200);
    expect(res.body.id).not.toBe(first.body.id);
  });

  const signed = (value: string) =>
    'lr_guest=' +
    encodeURIComponent(
      's:' + value + '.' + createHmac('sha256', process.env.COOKIE_SECRET!).update(value).digest('base64').replace(/=+$/, ''),
    );

  it('does not accept an unsigned guest id', async () => {
    const first = await request(server()).get('/me');
    const res = await request(server()).get('/me').set('Cookie', 'lr_guest=' + first.body.id).expect(200);
    expect(res.body.id).not.toBe(first.body.id);
    expect(await prisma.guest.count()).toBe(2);
  });

  it('accepts a correctly signed id (helper matches cookie-parser)', async () => {
    const first = await request(server()).get('/me');
    const res = await request(server()).get('/me').set('Cookie', signed(first.body.id)).expect(200);
    expect(res.body.id).toBe(first.body.id);
  });

  it('treats a signed but malformed id as no guest', async () => {
    const res = await request(server()).get('/me').set('Cookie', signed('abc')).expect(200);
    expect(res.body.name).toMatch(/^guest-\d{4}$/);
  });

  it('replaces a cookie whose guest no longer exists', async () => {
    const first = await request(server()).get('/me');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    await prisma.guest.deleteMany();
    const res = await request(server()).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.id).not.toBe(first.body.id);
  });

  it('falls back to a six-digit name once the four-digit ones are taken', async () => {
    await prisma.guest.createMany({
      data: Array.from({ length: 10_000 }, (_, i) => ({
        name: `guest-${String(i).padStart(4, '0')}`,
        ipHash: 'x',
        balance: 0,
      })),
    });
    const res = await request(server()).get('/me').expect(200);
    expect(res.body.name).toMatch(/^guest-\d{6}$/);
  });

  it('refuses the 6th new guest from one network within the hour', async () => {
    for (let i = 0; i < 5; i++) await request(server()).get('/me').expect(200);
    const res = await request(server()).get('/me').expect(429);
    expect(res.body).toEqual({ error: 'too many new guests from this network, try in an hour' });
    expect(await prisma.guest.count()).toBe(5);
  });

  it('does not count requests from an existing guest against the limit', async () => {
    const first = await request(server()).get('/me');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    for (let i = 0; i < 10; i++) {
      await request(server()).get('/me').set('Cookie', cookie).expect(200);
    }
  });

  it('keys the limit on X-Forwarded-For when it comes from loopback', async () => {
    for (let i = 0; i < 5; i++) {
      await request(server()).get('/me').set('X-Forwarded-For', '203.0.113.7').expect(200);
    }
    await request(server()).get('/me').set('X-Forwarded-For', '203.0.113.7').expect(429);
    await request(server()).get('/me').set('X-Forwarded-For', '203.0.113.8').expect(200);
  });
});

describe('guests behind an untrusted peer', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The test client connects from loopback, which this list does not name.
    process.env.TRUST_PROXY = '203.0.113.1';
    app = await bootApp();
    await resetDb(app.get(PrismaService));
    await flushRedis(app.get(REDIS));
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app.close();
  });

  it('ignores X-Forwarded-For from a peer TRUST_PROXY does not list', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get('/me').set('X-Forwarded-For', `203.0.113.${10 + i}`).expect(200);
    }
    await request(app.getHttpServer()).get('/me').set('X-Forwarded-For', '203.0.113.99').expect(429);
  });
});
