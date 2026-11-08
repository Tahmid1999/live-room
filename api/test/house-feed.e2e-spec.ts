import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { HouseFeed } from '../src/rooms/house-feed';
import { seedHouseRooms } from '../src/seed';
import { tapLabel } from '../src/wallet/gifts';
import { allowJoin, bootApp, connectClient, flushRedis, resetDb, urlOf } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A plain http request so the test sees exactly what an EventSource would.
function openFeed(url: string, key: string | undefined = process.env.HOUSE_KEY) {
  const seen: any[] = [];
  let buffer = '';
  let req!: http.ClientRequest;
  const ready = new Promise<number>((resolve, reject) => {
    req = http.get(
      `${url}/house/feed`,
      { agent: false, headers: key === undefined ? {} : { 'x-house-key': key } },
      (res) => {
        resolve(res.statusCode!);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          for (const frame of frames) {
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (data) seen.push(JSON.parse(data.slice(6)));
          }
        });
      },
    );
    req.on('error', reject);
  });
  return {
    seen,
    ready,
    async waitFor(match: (e: any) => boolean, ms = 4000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = seen.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no matching event within ${ms} ms`);
        await sleep(15);
      }
    },
    close: () => req.destroy(),
  };
}

describe('house feed', () => {
  let a: INestApplication;
  let b: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let video: Room;

  beforeAll(async () => {
    a = await bootApp({ replica: 'api-1' });
    b = await bootApp({ replica: 'api-2' });
    prisma = a.get(PrismaService);
    redis = a.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    video = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  async function newGuest(app: INestApplication) {
    const res = await request(app.getHttpServer()).get('/me').expect(200);
    return { cookie: (res.headers['set-cookie'][0] as string).split(';')[0], ...res.body };
  }

  it('refuses a missing or wrong house key', async () => {
    await request(a.getHttpServer()).get('/house/feed').expect(401);
    await request(a.getHttpServer()).get('/house/feed').set('x-house-key', 'nope').expect(401);
  });

  it('streams a join with the guest name', async () => {
    const feed = openFeed(urlOf(a));
    try {
      expect(await feed.ready).toBe(200);
      const guest = await newGuest(a);
      await request(a.getHttpServer()).post(`/rooms/${video.id}/join`).set('Cookie', guest.cookie).expect(200);

      const event = await feed.waitFor((e) => e.type === 'join');
      expect(event).toMatchObject({ type: 'join', roomId: video.id, name: guest.name });
      expect(Math.abs(event.t - Date.now())).toBeLessThan(5000);
      expect(Object.keys(event).sort()).toEqual(['name', 'roomId', 't', 'type']);
    } finally {
      feed.close();
    }
  });

  it('streams a gift sent on the other replica, with the short tap code', async () => {
    const feed = openFeed(urlOf(a));
    try {
      await feed.ready;
      const sender = await newGuest(b);
      const tapId = randomUUID();
      await request(b.getHttpServer())
        .post(`/rooms/${video.id}/gifts`)
        .set('Cookie', sender.cookie)
        .send({ giftId: 'tea', tapId })
        .expect(200);

      const event = await feed.waitFor((e) => e.type === 'gift');
      expect(event).toMatchObject({
        type: 'gift',
        roomId: video.id,
        name: sender.name,
        giftId: 'tea',
        replica: 'api-2',
        tap: tapLabel(tapId).replace('tap-', ''),
      });
      expect(event.tap).toMatch(/^[0-9a-f]{4}$/);
      expect(event.coins).toEqual(expect.any(Number));
      expect(JSON.stringify(event)).not.toContain(tapId);
      expect(JSON.stringify(event)).not.toContain(sender.id);
    } finally {
      feed.close();
    }
  });

  it('streams the viewer count when a socket joins a room', async () => {
    const feed = openFeed(urlOf(a));
    const viewer = await newGuest(a);
    const client = await connectClient(urlOf(a), viewer.cookie);
    try {
      await feed.ready;
      await allowJoin(viewer.cookie, video.id);
      client.socket.emit('room:join', { roomId: video.id });
      const event = await feed.waitFor((e) => e.type === 'viewers');
      expect(event).toMatchObject({ type: 'viewers', roomId: video.id, count: 1 });
    } finally {
      client.socket.close();
      feed.close();
    }
  });

  it('releases the subscriber when the client closes', async () => {
    const feeds = a.get(HouseFeed);
    const before = feeds.openStreams;
    const feed = openFeed(urlOf(a));
    await feed.ready;
    expect(feeds.openStreams).toBe(before + 1);
    feed.close();
    for (let i = 0; i < 100 && feeds.openStreams !== before; i++) await sleep(15);
    expect(feeds.openStreams).toBe(before);
  });

  it('reports server time in /me', async () => {
    const res = await request(a.getHttpServer()).get('/me').expect(200);
    expect(typeof res.body.now).toBe('number');
    expect(Math.abs(res.body.now - Date.now())).toBeLessThan(1000);
  });

  it('never fails the caller when the publish rejects', async () => {
    const feeds = a.get(HouseFeed);
    const spy = jest.spyOn(redis, 'publish').mockRejectedValueOnce(new Error('down'));
    expect(() => feeds.publish({ type: 'viewers', roomId: video.id, count: 1 })).not.toThrow();
    await sleep(50);
    spy.mockRestore();
  });
});
