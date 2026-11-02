import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { EventsService, HoodEvent } from '../src/events/events.service';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, connectClient, flushRedis, resetDb, urlOf } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GIFT_LINE = /^gift tap-[0-9a-f]{4} · lock \d+ ms · tx \d+ ms · api-\d · fan-out \d+ sockets$/;

// A plain http request so the test sees exactly what an EventSource would.
function openStream(url: string) {
  const seen: HoodEvent[] = [];
  let buffer = '';
  let req!: http.ClientRequest;
  // Resolves once the response headers are in, i.e. the server has accepted
  // the subscription; anything triggered after this reaches the stream live.
  const ready = new Promise<void>((resolve, reject) => {
    req = http.get(`${url}/events/stream`, { agent: false }, (res) => {
      resolve();
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
    });
    req.on('error', reject);
  });
  return {
    seen,
    ready,
    async waitFor(match: (e: HoodEvent) => boolean, ms = 4000) {
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

describe('events', () => {
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
    return { cookie: (res.headers['set-cookie'][0] as string).split(';')[0], id: res.body.id };
  }

  const gift = (app: INestApplication, cookie: string, tapId = randomUUID(), giftId = 'tea') =>
    request(app.getHttpServer())
      .post(`/rooms/${video.id}/gifts`)
      .set('Cookie', cookie)
      .send({ giftId, tapId });

  it('streams a gift made on the other replica, with the fan-out it reached', async () => {
    const viewer = await newGuest(a);
    const watcher = await connectClient(urlOf(a), viewer.cookie);
    watcher.socket.emit('room:join', { roomId: video.id });
    await watcher.waitFor('chat:history');

    const stream = openStream(urlOf(a));
    try {
      await stream.ready;
      const sender = await newGuest(b);
      await gift(b, sender.cookie).expect(200);

      const event = await stream.waitFor((e) => e.kind === 'gift');
      expect(event.text).toMatch(GIFT_LINE);
      expect(event.text).toContain('api-2');
      expect(event.text).toContain('fan-out 1 sockets');
      expect(event.replica).toBe('api-2');
    } finally {
      stream.close();
      watcher.socket.close();
    }
  });

  it('replays what happened before the stream was opened', async () => {
    const sender = await newGuest(a);
    await gift(a, sender.cookie).expect(200);
    // The gift event is published by the detached fan-out, after the response.
    for (let i = 0; i < 100; i++) {
      if ((await a.get(EventsService).recent()).length) break;
      await sleep(15);
    }
    a.get(EventsService).note('retention', 'marker');

    const stream = openStream(urlOf(b));
    try {
      await stream.ready;
      await stream.waitFor((e) => e.kind === 'gift');
      await stream.waitFor((e) => e.text === 'marker · api-1');
      expect(stream.seen.map((e) => e.kind)).toEqual(['gift', 'retention']);
    } finally {
      stream.close();
    }
  });

  it('keeps the last 200, oldest first', async () => {
    const events = a.get(EventsService);
    for (let i = 0; i < 205; i++) events.note('engine', `n${i}`);
    // emit is detached; the Redis round trips are queued on one connection
    await sleep(300);
    const res = await request(a.getHttpServer()).get('/events/recent').expect(200);
    expect(res.body).toHaveLength(200);
    expect(res.body[0].text).toBe('n5 · api-1');
    expect(res.body[199].text).toBe('n204 · api-1');
  });

  it('shows refusals, and nothing that identifies a person', async () => {
    const sender = await newGuest(a);
    await gift(a, sender.cookie).expect(200);
    const dupTap = randomUUID();
    await gift(a, sender.cookie, dupTap).expect(200);
    await gift(a, sender.cookie, dupTap).expect(200);
    await prisma.guest.update({ where: { id: sender.id }, data: { balance: 0 } });
    await gift(a, sender.cookie).expect(402);

    await request(a.getHttpServer())
      .post(`/rooms/${video.id}/join`)
      .set('Cookie', sender.cookie)
      .expect(200);
    await prisma.room.update({ where: { id: video.id }, data: { status: 'KILLED' } });
    await request(a.getHttpServer())
      .post(`/rooms/${video.id}/join`)
      .set('Cookie', sender.cookie)
      .expect(410);
    await sleep(300);

    const res = await request(a.getHttpServer()).get('/events/recent').expect(200);
    const lines = (res.body as HoodEvent[]).map((e) => `${e.kind}: ${e.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^gift: gift tap-/),
        expect.stringMatching(/^gift-dup: dup tap-[0-9a-f]{4} · api-1$/),
        expect.stringMatching(/^gift-rejected: refused tap-[0-9a-f]{4} · not enough coins · api-1$/),
        'engine: join video room · engine agora · api-1',
        'join-refused: refused join · room ended · api-1',
      ]),
    );

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:/);
    expect(json).not.toContain('lr_guest');
    expect(json).not.toMatch(/s:|eyJ/);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(json).not.toMatch(/[0-9a-f]{24}/i);
    expect(json).not.toContain(sender.id);
  });

  it('collapses a burst of refusals so real events are not pushed out', async () => {
    const sender = await newGuest(a);
    await gift(a, sender.cookie).expect(200);
    const events = a.get(EventsService);

    // 5 new guests per IP an hour: most of these are refused
    await Promise.all(Array.from({ length: 50 }, () => request(a.getHttpServer()).get('/me')));
    await sleep(300);
    const first = (await events.recent()).map((e) => e.kind);
    expect(first.filter((k) => k === 'rate-limit').length).toBeLessThanOrEqual(3);
    expect(first).toContain('gift');

    // the next one let through says how many it stands for
    for (let i = 0; i < 30; i++) events.note('rate-limit', 'rate-limit chat');
    await sleep(1100);
    events.note('rate-limit', 'rate-limit chat');
    await sleep(300);
    const texts = (await events.recent()).map((e) => e.text);
    expect(texts).toContain('rate-limit chat · api-1 · x30');
    expect(texts.filter((t) => t.startsWith('rate-limit chat')).length).toBe(2);
  });

  it('names the limit that refused, without who hit it', async () => {
    const sender = await newGuest(a);
    // 10 a second is the cap; the 11th inside one window is refused
    const taps = await Promise.all(
      Array.from({ length: 12 }, () => gift(a, sender.cookie, randomUUID(), 'tea')),
    );
    expect(taps.some((r) => r.status === 429)).toBe(true);
    await sleep(300);
    const res = await request(a.getHttpServer()).get('/events/recent').expect(200);
    expect((res.body as HoodEvent[]).filter((e) => e.kind === 'rate-limit')[0]).toMatchObject({
      text: 'rate-limit gift · api-1',
    });
  });
});
