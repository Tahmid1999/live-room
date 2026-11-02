import { HttpException, INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { WalletService } from '../src/wallet/wallet.service';
import { bootApp, flushRedis, resetDb } from './helpers';

describe('wallet', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let room: Room;
  let guestId: string;

  beforeAll(async () => {
    appA = await bootApp();
    appB = await bootApp();
    prisma = appA.get(PrismaService);
    redis = appA.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    room = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
    guestId = (
      await prisma.guest.create({ data: { name: 'guest-0001', ipHash: 'x', balance: 1000 } })
    ).id;
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  });

  const wallets = () => [appA.get(WalletService), appB.get(WalletService)];
  const balanceOf = async (id = guestId) =>
    (await prisma.guest.findUniqueOrThrow({ where: { id } })).balance;

  async function ledgerSum() {
    const sum = await prisma.ledgerEntry.aggregateRaw({
      pipeline: [{ $group: { _id: null, total: { $sum: '$amount' } } }],
    });
    return (sum[0] as { total: number } | undefined)?.total ?? 0;
  }

  describe('sendGift under contention', () => {
    // rose costs 50
    const fifty = () =>
      Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          wallets()[i % 2].sendGift({ guestId, roomId: room.id, giftId: 'rose', tapId: randomUUID() }),
        ),
      );

    it('50 parallel gifts of 50 coins, split across A and B, from one guest', async () => {
      const results = await fifty();
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(ok).toHaveLength(20);
      expect(failed).toHaveLength(30);
      for (const f of failed) {
        expect(f.reason).toBeInstanceOf(HttpException);
        expect(f.reason.getStatus()).toBe(402);
        expect(f.reason.getResponse()).toEqual({ error: 'not enough coins' });
      }
      expect(await balanceOf()).toBe(0);
      expect(await prisma.gift.count()).toBe(20);
      expect(await prisma.ledgerEntry.count()).toBe(60);
      expect(await prisma.hostEarning.count()).toBe(20);
    });

    it('ledger sums to zero', async () => {
      await fifty();
      expect(await prisma.ledgerEntry.count()).toBeGreaterThan(0);
      expect(await ledgerSum()).toBe(0);
    });

    it('first request commits but the client retries', async () => {
      const tapId = randomUUID();
      const first = await appA
        .get(WalletService)
        .sendGift({ guestId, roomId: room.id, giftId: 'rose', tapId });
      expect(first).toMatchObject({ balance: 950, coins: 50, duplicate: false });

      const retries = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          wallets()[i % 2].sendGift({ guestId, roomId: room.id, giftId: 'rose', tapId }),
        ),
      );
      expect(retries.every((r) => r.duplicate && r.balance === 950)).toBe(true);
      expect(await balanceOf()).toBe(950);
      expect(await prisma.gift.count()).toBe(1);
      expect(await prisma.ledgerEntry.count()).toBe(3);
    });
  });

  it('emits gift.committed once per new gift, not for a duplicate', async () => {
    const seen: { gift: { tapId: string }; room: { id: string } }[] = [];
    appA.get(EventEmitter2).on('gift.committed', (e) => seen.push(e));
    const tapId = randomUUID();
    const input = { guestId, roomId: room.id, giftId: 'tea', tapId };
    await appA.get(WalletService).sendGift(input);
    await appA.get(WalletService).sendGift(input);
    expect(seen).toHaveLength(1);
    expect(seen[0].gift.tapId).toBe(tapId);
    expect(seen[0].room.id).toBe(room.id);
  });

  describe('split of one gift', () => {
    it.each([
      ['tea', 10, 6, 4],
      ['rose', 50, 30, 20],
      ['clap', 100, 60, 40],
      ['star', 300, 180, 120],
      ['crown', 500, 300, 200],
    ])('%s costs %i: host %i, platform %i, entries sum to 0', async (giftId, coins, host, platform) => {
      const tapId = randomUUID();
      await appA.get(WalletService).sendGift({ guestId, roomId: room.id, giftId, tapId });
      const entries = await prisma.ledgerEntry.findMany({ where: { tapId } });
      const byAccount = Object.fromEntries(entries.map((e) => [e.account, e.amount]));
      expect(byAccount).toEqual({
        [`guest:${guestId}`]: -coins,
        [`host:${room.id}`]: host,
        platform,
      });
      expect(entries.reduce((s, e) => s + e.amount, 0)).toBe(0);
      expect((await prisma.hostEarning.findUniqueOrThrow({ where: { tapId } })).amount).toBe(host);
    });
  });

  describe('POST /rooms/:id/gifts', () => {
    const server = () => appA.getHttpServer();
    let cookie: string;

    beforeEach(async () => {
      const res = await request(server()).get('/me').expect(200);
      cookie = res.headers['set-cookie'][0].split(';')[0];
      guestId = res.body.id;
    });

    const send = (body: object, headers: Record<string, string> = {}, roomId = room.id) =>
      request(server()).post(`/rooms/${roomId}/gifts`).set('Cookie', cookie).set(headers).send(body);

    it('same tapId twice over HTTP is charged once', async () => {
      const body = { giftId: 'rose', tapId: randomUUID() };
      const first = await send(body).expect(200);
      expect(first.body).toMatchObject({ balance: 950, coins: 50, duplicate: false });
      const second = await send(body).expect(200);
      expect(second.body).toMatchObject({ balance: 950, duplicate: true });
      expect(await prisma.gift.count()).toBe(1);
    });

    it('402 when the wallet is short, and nothing is written', async () => {
      await prisma.guest.update({ where: { id: guestId }, data: { balance: 40 } });
      const res = await send({ giftId: 'rose', tapId: randomUUID() }).expect(402);
      expect(res.body).toEqual({ error: 'not enough coins' });
      expect(await balanceOf()).toBe(40);
      expect(await prisma.gift.count()).toBe(0);
      expect(await prisma.ledgerEntry.count()).toBe(0);
      expect(await prisma.hostEarning.count()).toBe(0);
      // the lock was released: a gift the guest can afford goes straight through
      await send({ giftId: 'tea', tapId: randomUUID() }).expect(200);
    });

    it('rejects an unknown gift, a bad tapId and a room that is not live', async () => {
      await send({ giftId: 'nope', tapId: randomUUID() }).expect(400);
      await send({ giftId: 'tea', tapId: 'not-a-uuid' }).expect(400);
      await send({ giftId: 'tea' }).expect(400);
      await send({ giftId: 'tea', tapId: randomUUID() }, {}, '0'.repeat(24)).expect(404);
      await prisma.room.update({ where: { id: room.id }, data: { status: 'ENDED' } });
      await send({ giftId: 'tea', tapId: randomUUID() }).expect(410);
      expect(await prisma.gift.count()).toBe(0);
    });

    it('does not let another guest reuse a tapId', async () => {
      const tapId = randomUUID();
      await send({ giftId: 'tea', tapId }).expect(200);
      const other = await request(server()).get('/me');
      const otherCookie = other.headers['set-cookie'][0].split(';')[0];
      await request(server())
        .post(`/rooms/${room.id}/gifts`)
        .set('Cookie', otherCookie)
        .send({ giftId: 'tea', tapId })
        .expect(409);
      expect(await prisma.gift.count()).toBe(1);
    });

    it('11 quick taps: the 11th gets 429', async () => {
      const taps = await Promise.all(
        Array.from({ length: 11 }, () => send({ giftId: 'tea', tapId: randomUUID() })),
      );
      const slow = taps.filter((t) => t.status === 429);
      expect(slow).toHaveLength(1);
      expect(slow[0].body).toEqual({ error: 'slow down' });
      expect(taps.filter((t) => t.status === 200)).toHaveLength(10);
    });

    it('x-burst lets 20 taps through once per minute', async () => {
      // 100 coins each: 10 fit in the wallet, the rest are 402, but none is a 429
      const burst = await Promise.all(
        Array.from({ length: 20 }, () =>
          send({ giftId: 'clap', tapId: randomUUID() }, { 'x-burst': '1' }),
        ),
      );
      expect(burst.filter((r) => r.status === 200)).toHaveLength(10);
      expect(burst.filter((r) => r.status === 402)).toHaveLength(10);

      const again = await send({ giftId: 'tea', tapId: randomUUID() }, { 'x-burst': '1' });
      expect(again.status).toBe(429);
      expect(again.body).toEqual({ error: 'slow down' });
    });
  });
});
