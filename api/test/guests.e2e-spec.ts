import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
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

  it('replaces a cookie whose guest no longer exists', async () => {
    const first = await request(server()).get('/me');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    await prisma.guest.deleteMany();
    const res = await request(server()).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.id).not.toBe(first.body.id);
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
