import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import http from 'node:http';
import request from 'supertest';
import { EgressService } from '../src/egress/egress.service';
import { MAX_STREAMS } from '../src/events/events.service';
import { PrismaService } from '../src/prisma.service';
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
