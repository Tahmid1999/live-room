import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { recordReport } from '../src/egress/reports';
import { EventsService } from '../src/events/events.service';
import { SettlementService } from '../src/jobs/settlement.service';
import { markPresent } from '../src/presence';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { WalletService } from '../src/wallet/wallet.service';
import { bootApp, Client, flushRedis, joinWithRejoin, resetDb, urlOf } from './helpers';

const PASSWORD = process.env.ADMIN_PASSWORD!;

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('admin', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let video: Room;
  let audio: Room;
  let clients: Client[];
  let at: number;

  beforeAll(async () => {
    appA = await bootApp({ replica: 'api-1' });
    appB = await bootApp({ replica: 'api-2' });
    prisma = appA.get(PrismaService);
    redis = appA.get(REDIS);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    at = Date.now();
    for (const app of [appA, appB]) jest.spyOn(app.get(CLOCK), 'now').mockImplementation(() => at);
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    video = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
    audio = (await prisma.room.findFirst({ where: { house: true, kind: 'AUDIO' } }))!;
    clients = [];
  });

  afterEach(() => {
    clients.forEach((c) => c.socket.close());
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  });

  async function login(app = appA) {
    const res = await request(app.getHttpServer()).post('/admin/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'][0] as string).split(';')[0];
  }

  describe('read endpoints', () => {
    it('answer without a login and carry no guest identifiers', async () => {
      const guest = await prisma.guest.create({
        data: { name: 'guest-0042', ipHash: 'abc123hash', balance: 1000 },
      });
      await appA.get(WalletService).sendGift({
        guestId: guest.id,
        roomId: video.id,
        giftId: 'rose',
        tapId: 'a1b2c3d4-0000-4000-8000-000000000001',
      });
      const server = appA.getHttpServer();
      for (const path of ['rooms', 'gifts', 'wallets', 'payouts']) {
        const res = await request(server).get(`/admin/${path}`).expect(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('ipHash');
        expect(text).not.toContain('abc123hash');
        expect(text).not.toContain(guest.id);
        expect(text).not.toContain('a1b2c3d4');
      }
    });

    it('lists every room with viewers, bandwidth and age', async () => {
      at += 90_000;
      await markPresent(redis, video.id, 'g1', at);
      await recordReport(redis, video.id, 'g1', 1_200_000, at);
      await recordReport(redis, video.id, 'g2', 1_600_000, at);
      const res = await request(appA.getHttpServer()).get('/admin/rooms').expect(200);
      expect(res.body).toHaveLength(2);
      const card = res.body.find((r: { id: string }) => r.id === video.id);
      expect(card).toEqual({
        id: video.id,
        kind: 'VIDEO',
        engine: 'agora',
        title: video.title,
        hostName: video.hostName,
        house: true,
        status: 'LIVE',
        viewers: 2,
        perViewerBps: 1_400_000,
        totalBps: 2_800_000,
        ageSec: Math.floor((at - video.createdAt.getTime()) / 1000),
      });
      expect(res.body.find((r: { id: string }) => r.id === audio.id)).toMatchObject({
        viewers: 0,
        totalBps: 0,
      });
    });

    it('shows recent gifts newest first with the guest name, and honours limit', async () => {
      const guest = await prisma.guest.create({
        data: { name: 'guest-0042', ipHash: 'x', balance: 1000 },
      });
      const wallet = appA.get(WalletService);
      for (const [i, giftId] of ['tea', 'rose', 'clap'].entries()) {
        await wallet.sendGift({ guestId: guest.id, roomId: audio.id, giftId, tapId: `tap-${i}` });
      }
      const all = await request(appA.getHttpServer()).get('/admin/gifts').expect(200);
      expect(all.body.map((g: { giftId: string }) => g.giftId)).toEqual(['clap', 'rose', 'tea']);
      expect(all.body[0]).toEqual({
        at: expect.any(Number),
        guest: 'guest-0042',
        room: audio.title,
        giftId: 'clap',
        coins: 100,
      });
      const one = await request(appA.getHttpServer()).get('/admin/gifts?limit=1').expect(200);
      expect(one.body).toHaveLength(1);
    });

    it('names a gift whose guest has been purged instead of failing', async () => {
      const guest = await prisma.guest.create({
        data: { name: 'guest-0042', ipHash: 'x', balance: 1000 },
      });
      await appA.get(WalletService).sendGift({ guestId: guest.id, roomId: audio.id, giftId: 'tea', tapId: 'gone-1' });
      await prisma.guest.delete({ where: { id: guest.id } });
      const res = await request(appA.getHttpServer()).get('/admin/gifts').expect(200);
      expect(res.body).toEqual([expect.objectContaining({ guest: 'expired guest', giftId: 'tea' })]);
    });

    it('reports coins, a zero ledger sum and gifts since UTC midnight', async () => {
      const guest = await prisma.guest.create({
        data: { name: 'guest-0042', ipHash: 'x', balance: 1000 },
      });
      const wallet = appA.get(WalletService);
      await wallet.sendGift({ guestId: guest.id, roomId: video.id, giftId: 'tea', tapId: 'w-1' });
      await wallet.sendGift({ guestId: guest.id, roomId: video.id, giftId: 'rose', tapId: 'w-2' });
      // Yesterday's gift: counted in circulation terms, not in today's total.
      await prisma.gift.update({
        where: { tapId: 'w-1' },
        data: { createdAt: new Date(Date.UTC(2000, 0, 1)) },
      });
      const res = await request(appA.getHttpServer()).get('/admin/wallets').expect(200);
      expect(res.body).toEqual({ coinsInCirculation: 940, ledgerSum: 0, giftsToday: 1 });
    });

    it('reports unsettled earnings, then the run and payouts after settlement', async () => {
      const guest = await prisma.guest.create({
        data: { name: 'guest-0042', ipHash: 'x', balance: 1000 },
      });
      const wallet = appA.get(WalletService);
      await wallet.sendGift({ guestId: guest.id, roomId: video.id, giftId: 'tea', tapId: 'p-1' });
      await wallet.sendGift({ guestId: guest.id, roomId: video.id, giftId: 'rose', tapId: 'p-2' });
      const before = await request(appA.getHttpServer()).get('/admin/payouts').expect(200);
      expect(before.body).toEqual({ earningsUnsettled: 36, runs: [], payouts: [] });

      await appA.get(SettlementService).runOnce();
      const after = await request(appA.getHttpServer()).get('/admin/payouts').expect(200);
      expect(after.body.earningsUnsettled).toBe(0);
      expect(after.body.runs).toHaveLength(1);
      expect(after.body.runs[0]).toMatchObject({ rows: 2, total: 36 });
      expect(after.body.payouts).toEqual([
        expect.objectContaining({ roomId: video.id, amount: 36, runId: after.body.runs[0].id }),
      ]);
    });
  });

  describe('login', () => {
    const attempt = (password: unknown, app = appA) =>
      request(app.getHttpServer()).post('/admin/login').send({ password });

    it('sets an httpOnly strict cookie lasting 12 hours', async () => {
      const res = await attempt(PASSWORD).expect(200);
      const cookie = res.headers['set-cookie'][0] as string;
      expect(cookie).toMatch(/^lr_admin=[\w-]+\.[\w-]+\.[\w-]+;/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Max-Age=43200');
      expect(cookie).not.toContain('Secure');
    });

    it('marks the cookie Secure behind a TLS-terminating proxy', async () => {
      const res = await request(appA.getHttpServer())
        .post('/admin/login')
        .set('X-Forwarded-Proto', 'https')
        .send({ password: PASSWORD })
        .expect(200);
      expect(res.headers['set-cookie'][0]).toContain('Secure');
    });

    it('refuses a wrong password and a missing one', async () => {
      await attempt('nope').expect(401);
      await attempt(undefined).expect(400);
      await attempt(['x']).expect(400);
    });

    it('answers /admin/me from the cookie', async () => {
      const server = appA.getHttpServer();
      expect((await request(server).get('/admin/me')).body).toEqual({ admin: false });
      const cookie = await login();
      expect((await request(server).get('/admin/me').set('Cookie', cookie)).body).toEqual({
        admin: true,
      });
    });

    it('answers 429 from the 6th attempt in an hour, even with the right password', async () => {
      for (let i = 0; i < 5; i++) await attempt('wrong').expect(401);
      await attempt(PASSWORD).expect(429);
      await until(async () =>
        (await appA.get(EventsService).recent()).some((e) => e.text.startsWith('rate-limit admin login')),
      );
    });

    it('counts attempts across replicas', async () => {
      for (let i = 0; i < 3; i++) await attempt('wrong', appA).expect(401);
      for (let i = 0; i < 2; i++) await attempt('wrong', appB).expect(401);
      await attempt(PASSWORD, appA).expect(429);
    });
  });

  describe('kill', () => {
    const kill = (id: string, cookie?: string, app = appA) => {
      const req = request(app.getHttpServer()).post(`/admin/rooms/${id}/kill`);
      return cookie ? req.set('Cookie', cookie) : req;
    };

    it('needs the cookie', async () => {
      await kill(audio.id).expect(401);
      await kill(audio.id, 'lr_admin=garbage').expect(401);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: audio.id } })).status).toBe('LIVE');
    });

    it('rejects a token with a bad signature, alg none, or past its expiry', async () => {
      const good = (await login()).split('=')[1];
      const [h, b, s] = good.split('.');
      const forgedBody = Buffer.from(
        JSON.stringify({ sub: 'admin', iat: 1, exp: Math.floor(at / 1000) + 99999 }),
      ).toString('base64url');
      await kill(audio.id, `lr_admin=${h}.${forgedBody}.${s}`).expect(401);
      const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      await kill(audio.id, `lr_admin=${none}.${b}.`).expect(401);
      await kill(audio.id, `lr_admin=${none}.${b}.${s}`).expect(401);

      await kill(audio.id, `lr_admin=${good}`).expect(200);
      at += 12 * 3600 * 1000 + 1000;
      await kill(video.id, `lr_admin=${good}`).expect(401);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: video.id } })).status).toBe('LIVE');
    });

    it('rejects a token signed with a different key', async () => {
      const good = (await login()).split('=')[1];
      const [h, b] = good.split('.');
      const sig = createHmac('sha256', 'some other key').update(`${h}.${b}`).digest('base64url');
      await kill(audio.id, `lr_admin=${h}.${b}.${sig}`).expect(401);
    });

    it('kills the room, tells a viewer on the other replica and logs one hood event', async () => {
      const me = await request(appB.getHttpServer()).get('/me').expect(200);
      const guestCookie = (me.headers['set-cookie'][0] as string).split(';')[0];
      const viewer = await joinWithRejoin(urlOf(appB), guestCookie, audio.id);
      clients.push(viewer);
      await viewer.waitFor('chat:history');

      const res = await kill(audio.id, await login(), appA).expect(200);
      expect(res.body).toEqual({ id: audio.id, status: 'KILLED' });
      expect(await viewer.waitFor('room:killed')).toEqual({});
      expect((await prisma.room.findUniqueOrThrow({ where: { id: audio.id } })).status).toBe('KILLED');

      await until(async () => (await appA.get(EventsService).recent()).some((e) => e.kind === 'kill'));
      const events = (await appA.get(EventsService).recent()).filter((e) => e.kind === 'kill');
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('kill audio room · api-1');
    });

    it('is idempotent: a second kill answers 200 with no second event or broadcast', async () => {
      const me = await request(appA.getHttpServer()).get('/me').expect(200);
      const viewer = await joinWithRejoin(
        urlOf(appA),
        (me.headers['set-cookie'][0] as string).split(';')[0],
        video.id,
      );
      clients.push(viewer);
      await viewer.waitFor('chat:history');
      const cookie = await login();

      await kill(video.id, cookie).expect(200);
      await viewer.waitFor('room:killed');
      await until(async () => (await appA.get(EventsService).recent()).some((e) => e.kind === 'kill'));
      await kill(video.id, cookie, appB).expect(200);
      // A stray second broadcast or event would have landed by now.
      await new Promise((r) => setTimeout(r, 200));
      expect(viewer.count('room:killed')).toBe(1);
      expect((await appA.get(EventsService).recent()).filter((e) => e.kind === 'kill')).toHaveLength(1);
    });

    it('stops chat and reports from a socket that ignores room:killed', async () => {
      const guestOn = async (app: INestApplication) => {
        const me = await request(app.getHttpServer()).get('/me').expect(200);
        const c = await joinWithRejoin(urlOf(app), (me.headers['set-cookie'][0] as string).split(';')[0], audio.id);
        clients.push(c);
        await c.waitFor('chat:history');
        return { c, id: me.body.id as string };
      };
      const listener = (await guestOn(appA)).c;
      const rogue = await guestOn(appB);

      await kill(audio.id, await login(), appA).expect(200);
      await listener.waitFor('room:killed');
      await rogue.c.waitFor('room:killed');

      rogue.c.socket.emit('chat:send', { text: 'still here' });
      rogue.c.socket.emit('stats', { bps: 48_000 });
      expect(await rogue.c.waitFor('exception')).toEqual({ error: 'room has ended' });
      await new Promise((r) => setTimeout(r, 200));
      expect(listener.count('chat')).toBe(0);
      expect(rogue.c.count('chat')).toBe(0);
      expect(await redis.llen(`chat:${audio.id}`)).toBe(0);
      expect(await redis.hexists(`eg:${audio.id}`, rogue.id)).toBe(0);
    });

    it('answers 410 to a join once the room is killed', async () => {
      await kill(video.id, await login()).expect(200);
      const me = await request(appA.getHttpServer()).get('/me').expect(200);
      await request(appA.getHttpServer())
        .post(`/rooms/${video.id}/join`)
        .set('Cookie', (me.headers['set-cookie'][0] as string).split(';')[0])
        .expect(410);
    });

    it('answers 404 for a room that does not exist or an id that is not one', async () => {
      const cookie = await login();
      await kill('0123456789abcdef01234567', cookie).expect(404);
      await kill('not-an-id', cookie).expect(404);
    });
  });
});
