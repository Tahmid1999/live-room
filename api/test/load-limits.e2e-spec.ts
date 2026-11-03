import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import http from 'node:http';
import request from 'supertest';
import { EgressService } from '../src/egress/egress.service';
import { MAX_STREAMS } from '../src/events/events.service';
import { GuestsService } from '../src/guests/guests.service';
import { PrismaService } from '../src/prisma.service';
import { RoomGateway } from '../src/realtime/room.gateway';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, Client, connectClient, flushRedis, joinWithRejoin, resetDb, urlOf } from './helpers';

describe('load limits', () => {
  let app: INestApplication;
  let other: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let roomId: string;
  let clients: Client[];

  beforeAll(async () => {
    app = await bootApp({ readCacheMs: 1000 });
    other = await bootApp({ replica: 'b' });
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    roomId = (await prisma.room.findFirstOrThrow({ where: { house: true, kind: 'AUDIO' } })).id;
    clients = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clients.forEach((c) => c.socket.close());
  });

  afterAll(async () => {
    await app.close();
    await other.close();
  });

  async function connected(c: Client) {
    const deadline = Date.now() + 3000;
    while (!c.socket.connected) {
      if (Date.now() > deadline) throw new Error('socket did not connect');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  async function newGuestCookie() {
    const res = await request(app.getHttpServer()).get('/me').expect(200);
    return (res.headers['set-cookie'][0] as string).split(';')[0];
  }

  it('disconnects a socket that sends more than 30 events in 10 s', async () => {
    const c = await joinWithRejoin(urlOf(app), await newGuestCookie(), roomId);
    clients.push(c);
    c.socket.io.reconnection(false);
    await c.waitFor('chat:history');
    // The join was the first event; 29 more stay inside the budget.
    for (let i = 0; i < 29; i++) c.socket.emit('stats', {});
    await new Promise((r) => setTimeout(r, 300));
    expect(c.socket.connected).toBe(true);
    c.socket.emit('stats', {});
    expect(await c.waitFor('disconnect')).toBe('io server disconnect');
  });

  it('refuses a fourth socket for one guest, counted across replicas', async () => {
    const cookie = await newGuestCookie();
    for (const target of [app, other, app]) {
      const c = await connectClient(urlOf(target), cookie);
      clients.push(c);
      await connected(c);
    }
    const fourth = await connectClient(urlOf(other), cookie);
    clients.push(fourth);
    fourth.socket.io.reconnection(false);
    expect(await fourth.waitFor('connect_error')).toBe('too many connections');

    clients[0].socket.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await connectClient(urlOf(other), cookie);
    clients.push(again);
    await connected(again);
  });

  it('keeps the socket cap when one guest opens eight at once', async () => {
    const cookie = await newGuestCookie();
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) => connectClient(urlOf(i % 2 ? other : app), cookie)),
    );
    clients.push(...burst);
    burst.forEach((c) => c.socket.io.reconnection(false));
    const outcomes = await Promise.all(
      burst.map((c) =>
        // The client log does not record 'connect', so listen for it here.
        new Promise<string>((resolve) => {
          if (c.socket.connected) return resolve('in');
          c.socket.once('connect', () => resolve('in'));
          c.socket.once('connect_error', (err) => resolve(err.message));
        }),
      ),
    );
    const admitted = outcomes.filter((o) => o === 'in').length;
    expect(admitted).toBeGreaterThanOrEqual(1);
    expect(admitted).toBeLessThanOrEqual(3);
    // Refused by the cap, not by something else failing under the burst.
    expect(outcomes.filter((o) => o !== 'in').every((o) => o === 'too many connections')).toBe(true);
    // Every claim is gone once the burst has settled, admitted or refused.
    await new Promise((r) => setTimeout(r, 100));
    const [key] = await redis.keys('sockets:claims:*');
    expect(key ? await redis.zcard(key) : 0).toBe(0);
  });

  it.each(['the guest lookup', 'the adapter count'])(
    'drops the claim of a socket that closes during %s',
    async (stage) => {
      const cookie = await newGuestCookie();
      const slow = <T>(work: Promise<T>) => new Promise<T>((r) => setTimeout(() => r(work), 400));
      if (stage === 'the guest lookup') {
        const guests = app.get(GuestsService);
        const lookup = guests.fromCookieHeader.bind(guests);
        jest.spyOn(guests, 'fromCookieHeader').mockImplementation((h) => slow(lookup(h)));
      } else {
        const adapter = (app.get(RoomGateway) as any).server.of('/').adapter;
        const count = adapter.fetchSockets.bind(adapter);
        jest.spyOn(adapter, 'fetchSockets').mockImplementation((opts) => slow(count(opts)));
      }
      const c = await connectClient(urlOf(app), cookie);
      c.socket.io.reconnection(false);
      await new Promise((r) => setTimeout(r, 150));
      c.socket.io.engine.close();
      await new Promise((r) => setTimeout(r, 600));
      expect(await redis.keys('sockets:claims:*')).toEqual([]);
    },
  );

  it('answers 503 to the 101st open event stream', async () => {
    const { port } = app.getHttpServer().address();
    const open = () =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/events/stream' }, resolve).on('error', reject);
      });
    const streams: http.IncomingMessage[] = [];
    try {
      for (let i = 0; i < MAX_STREAMS; i++) {
        const res = await open();
        expect(res.statusCode).toBe(200);
        streams.push(res);
      }
      const refused = await open();
      expect(refused.statusCode).toBe(503);
      refused.resume();

      streams.pop()!.destroy();
      await new Promise((r) => setTimeout(r, 200));
      const next = await open();
      expect(next.statusCode).toBe(200);
      streams.push(next);
    } finally {
      streams.forEach((s) => s.destroy());
    }
  });

  it('serves repeated reads inside a second from one load', async () => {
    const rooms = jest.spyOn(app.get(PrismaService).room, 'findMany');
    const bandwidth = jest.spyOn(app.get(EgressService), 'bandwidth');
    const server = app.getHttpServer();
    await Promise.all(Array.from({ length: 10 }, () => request(server).get('/rooms').expect(200)));
    await Promise.all(Array.from({ length: 10 }, () => request(server).get('/bandwidth').expect(200)));
    const listed = rooms.mock.calls.length;
    await Promise.all(Array.from({ length: 10 }, () => request(server).get('/admin/rooms').expect(200)));
    await Promise.all(Array.from({ length: 10 }, () => request(server).get('/admin/wallets').expect(200)));
    expect(bandwidth).toHaveBeenCalledTimes(1);
    // /bandwidth reads the live rooms itself, so it is one more findMany.
    expect(listed).toBe(2);
    expect(rooms).toHaveBeenCalledTimes(3);

    await new Promise((r) => setTimeout(r, 1100));
    await request(server).get('/rooms').expect(200);
    expect(rooms).toHaveBeenCalledTimes(4);
  });
});
