import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { hasJoined } from '../src/rooms/joined';
import { LiveKitRooms } from '../src/rooms/livekit-rooms';
import { SeatSweep } from '../src/rooms/seat-sweep';
import { seedHouseRooms } from '../src/seed';
import {
  bootApp,
  Client,
  connectClient,
  flushRedis,
  joinWithRejoin,
  resetDb,
  urlOf,
} from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Only the sweep reads the node here: who sits where, and who it removed.
const node = {
  seats: new Map<string, string[]>(),
  removed: [] as [string, string][],
  async participants(room: string) {
    return this.seats.get(room) ?? [];
  },
  async remove(room: string, identity: string) {
    this.removed.push([room, identity]);
  },
} satisfies LiveKitRooms & { seats: Map<string, string[]>; removed: [string, string][] };

describe('realtime', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let room: Room;
  let clients: Client[];

  beforeAll(async () => {
    appA = await bootApp({ livekitRooms: node });
    appB = await bootApp();
    prisma = appA.get(PrismaService);
    redis = appA.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    room = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
    clients = [];
    node.seats.clear();
    node.removed = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clients.forEach((c) => c.socket.close());
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  });

  async function newGuestCookie(app = appA): Promise<string> {
    const res = await request(app.getHttpServer()).get('/me').expect(200);
    return (res.headers['set-cookie'][0] as string).split(';')[0];
  }

  async function joined(app: INestApplication, cookie: string): Promise<Client> {
    const c = await joinWithRejoin(urlOf(app), cookie, room.id);
    clients.push(c);
    await c.waitFor('chat:history');
    return c;
  }

  const sendGift = (cookie: string, giftId = 'tea') =>
    request(appA.getHttpServer())
      .post(`/rooms/${room.id}/gifts`)
      .set('Cookie', cookie)
      .send({ giftId, tapId: randomUUID() })
      .expect(200);

  const httpJoin = (cookie: string) =>
    request(appA.getHttpServer()).post(`/rooms/${room.id}/join`).set('Cookie', cookie).expect(200);

  it('refuses room:join from a guest who never went through POST /join', async () => {
    const c = await connectClient(urlOf(appA), await newGuestCookie());
    clients.push(c);
    c.socket.emit('room:join', { roomId: room.id });

    expect(await c.waitFor('exception')).toEqual({ error: 'join the room first' });
    expect(c.count('chat:history')).toBe(0);
    expect(await redis.zcard(`viewers:${room.id}`)).toBe(0);
  });

  it('lets the join, socket and renew path through in that order', async () => {
    const cookie = await newGuestCookie();
    await httpJoin(cookie);
    const c = await connectClient(urlOf(appA), cookie);
    clients.push(c);
    c.socket.emit('room:join', { roomId: room.id });
    await c.waitFor('chat:history');

    const res = await request(appA.getHttpServer())
      .post(`/rooms/${room.id}/renew`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toMatchObject({ kind: 'VIDEO', room: room.id });
  });

  // Joins over HTTP, then over the socket the way the web client does, and
  // survives reconnects by asking for the room again.
  async function rejoining(target: Room, cookie: string) {
    await request(appA.getHttpServer()).post(`/rooms/${target.id}/join`).set('Cookie', cookie).expect(200);
    const c = await connectClient(urlOf(appA), cookie);
    clients.push(c);
    c.socket.on('connect', () => c.socket.emit('room:join', { roomId: target.id }));
    c.socket.connect();
    await c.waitFor('chat:history');
    return c;
  }
  const guestIdOf = (cookie: string) => {
    const signed = decodeURIComponent(cookie.split('=')[1]);
    return signed.slice(2, signed.lastIndexOf('.'));
  };
  const MIN = 60_000;

  it('keeps an audio listener who keeps reporting in the room, and only that one', async () => {
    let at = Date.now();
    jest.spyOn(appA.get(CLOCK), 'now').mockImplementation(() => at);
    const audio = (await prisma.room.findFirst({ where: { house: true, kind: 'AUDIO' } }))!;

    const watching = await rejoining(audio, await newGuestCookie());
    const idle = await rejoining(audio, await newGuestCookie());

    at += 14 * MIN;
    watching.socket.emit('stats', { bps: 1000 });
    await sleep(300);
    at += 14 * MIN;

    for (const c of [watching, idle]) c.socket.disconnect().connect();
    await watching.waitFor('chat:history', 2);
    expect(await idle.waitFor('exception')).toEqual({ error: 'join the room first' });
    expect(idle.count('chat:history')).toBe(1);
  });

  it('does not let stats keep a video seat: only /join and /renew do', async () => {
    let at = Date.now();
    jest.spyOn(appA.get(CLOCK), 'now').mockImplementation(() => at);
    const cookie = await newGuestCookie();
    const guestId = guestIdOf(cookie);
    const watching = await rejoining(room, cookie);

    at += 14 * MIN;
    watching.socket.emit('stats', { bps: 1000 });
    await sleep(300);
    at += 14 * MIN;

    expect(await hasJoined(redis, room.id, guestId, at)).toBe(false);
    node.seats.set(room.id, ['house', guestId]);
    expect(await appA.get(SeatSweep).sweep(at)).toBe(1);
    expect(node.removed).toEqual([[room.id, guestId]]);
  });

  it('refuses a handshake from another origin, or with none', async () => {
    const cookie = await newGuestCookie();
    for (const origin of ['https://elsewhere.example', undefined]) {
      const socket = io(urlOf(appA), {
        transports: ['websocket'],
        extraHeaders: origin ? { cookie, origin } : { cookie },
        reconnection: false,
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', () => resolve('refused'));
      });
      socket.close();
      expect(outcome).toBe('refused');
    }
  });

  it('refuses a socket with no guest cookie', async () => {
    const c = await connectClient(urlOf(appA), '');
    clients.push(c);
    await c.waitFor('connect_error');
    expect(c.socket.connected).toBe(false);
  });

  it('delivers a gift sent through A to a socket on B', async () => {
    const sender = await newGuestCookie();
    const viewerOnB = await joined(appB, await newGuestCookie());
    await joined(appA, sender);

    await sendGift(sender, 'rose');

    expect(await viewerOnB.waitFor('gift')).toEqual({
      name: expect.stringMatching(/^guest-\d{4}$/),
      giftId: 'rose',
      coins: 50,
      at: expect.any(Number),
    });
  });

  it('counts viewers across replicas and drops them on leave and disconnect', async () => {
    const a = await joined(appA, await newGuestCookie());
    const b = await joined(appB, await newGuestCookie());
    expect((await a.waitFor('viewers', 2)).count).toBe(2);
    expect((await b.waitFor('viewers', 1)).count).toBe(2);

    b.socket.emit('room:leave');
    expect((await a.waitFor('viewers', 3)).count).toBe(1);

    a.socket.close();
    await sleep(200);
    expect(await redis.zcard(`viewers:${room.id}`)).toBe(0);
  });

  it('sends the current top 5 to a socket as it joins', async () => {
    const sender = await newGuestCookie();
    await joined(appA, sender);
    await sendGift(sender, 'rose');
    await sleep(1200);

    const late = await joined(appB, await newGuestCookie());

    expect(late.count('lb')).toBe(1);
    expect((await late.waitFor('lb')).top).toEqual([{ name: expect.any(String), coins: 50 }]);
  });

  it('skips board entries left from before it was keyed by guest id', async () => {
    const giver = await newGuestCookie();
    await sendGift(giver, 'rose');
    // The board is written after the gift commits, off the request.
    while ((await redis.zcard(`lb:${room.id}`)) === 0) await sleep(15);
    // More of them than the top 5, all above the real gifter.
    for (let i = 0; i < 7; i++) await redis.zadd(`lb:${room.id}`, 900 + i, `guest-955${i}`);
    const late = await joined(appB, await newGuestCookie());
    expect((await late.waitFor('lb')).top).toEqual([{ name: expect.stringMatching(/^guest-/), coins: 50 }]);
    expect(await redis.zcard(`lb:${room.id}`)).toBe(1);
  });

  it('pushes the leaderboard once, not once per replica', async () => {
    const sender = await newGuestCookie();
    const onB = await joined(appB, await newGuestCookie());
    const onA = await joined(appA, sender);

    await sendGift(sender);
    await sleep(1200);

    // The first lb on each socket is the snapshot it got on joining.
    for (const c of [onA, onB]) {
      expect(c.count('lb')).toBe(2);
      expect((await c.waitFor('lb', 2)).top).toEqual([{ name: expect.any(String), coins: 10 }]);
    }
  });

  it('does not lose the last leaderboard update inside the one-second gate', async () => {
    const sender = await newGuestCookie();
    const onB = await joined(appB, await newGuestCookie());

    await sendGift(sender, 'tea');
    await sendGift(sender, 'rose');
    await sendGift(sender, 'clap');

    const last = await onB.waitFor('lb', 3, 3000);
    expect(last.top[0].coins).toBe(160);
    expect(onB.count('lb')).toBe(3);
  });

  it('fans chat out, rejects bad text and a second message inside a second', async () => {
    const a = await joined(appA, await newGuestCookie());
    const b = await joined(appB, await newGuestCookie());

    a.socket.emit('chat:send', { text: 'hello https://x.io there' });
    expect(await b.waitFor('chat')).toEqual({
      name: expect.stringMatching(/^guest-/),
      text: 'hello there',
      at: expect.any(Number),
    });

    a.socket.emit('chat:send', { text: 'again' });
    expect(await a.waitFor('chat:rejected')).toEqual({ reason: 'slow-down' });
    // The limiter keeps out of chat:*, which is where room histories live.
    expect((await redis.keys('chat:*')).sort()).toEqual([`chat:${room.id}`]);

    b.socket.emit('chat:send', { text: 'https://x.io' });
    expect(await b.waitFor('chat:rejected')).toEqual({ reason: 'link-only' });
  });

  it('sends the last 50 messages to the joiner only', async () => {
    const stored = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ name: 'g', text: `m${i}`, at: i }),
    );
    // LPUSH order: the last argument ends up at the head, so m59 is newest
    await redis.lpush(`chat:${room.id}`, ...stored);

    const first = await joined(appA, await newGuestCookie());
    const second = await joined(appB, await newGuestCookie());

    const items = (await second.waitFor('chat:history')).items;
    expect(items).toHaveLength(50);
    expect(items[0].text).toBe('m10');
    expect(items[49].text).toBe('m59');
    expect(first.count('chat:history')).toBe(1);
  });

  it('a socket whose replica dies reconnects to another and hears the next chat', async () => {
    const appC = await bootApp();
    const viewer = await joinWithRejoin(urlOf(appC), await newGuestCookie(appC), room.id);
    clients.push(viewer);
    await viewer.waitFor('chat:history');
    const speaker = await joined(appB, await newGuestCookie());

    await appC.close();
    // Production reroutes the reconnect through Caddy; a test client has to be pointed at B.
    viewer.moveTo(urlOf(appB));
    await viewer.waitFor('chat:history', 2, 5000);

    speaker.socket.emit('chat:send', { text: 'still there?' });
    expect((await viewer.waitFor('chat')).text).toBe('still there?');
  });

  it('drops a client that sends a payload past the buffer limit', async () => {
    const a = await joined(appA, await newGuestCookie());
    a.socket.emit('chat:send', { text: 'x'.repeat(20_000) });
    await a.waitFor('disconnect');
    expect(a.socket.connected).toBe(false);
  });
});
