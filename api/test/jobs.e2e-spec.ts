import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { CLOCK } from '../src/clock';
import { EventsService } from '../src/events/events.service';
import { RetentionService } from '../src/jobs/retention.service';
import { SettlementService } from '../src/jobs/settlement.service';
import { PrismaService } from '../src/prisma.service';
import { REDIS, REDLOCK } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, flushRedis, resetDb } from './helpers';
import Redlock from 'redlock';

const HOUR = 3600 * 1000;

describe('jobs', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let rooms: Room[];
  let guestId: string;

  beforeAll(async () => {
    appA = await bootApp({ replica: 'api-1' });
    appB = await bootApp({ replica: 'api-2' });
    prisma = appA.get(PrismaService);
    redis = appA.get(REDIS);
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    rooms = await prisma.room.findMany({ where: { house: true } });
    guestId = (
      await prisma.guest.create({ data: { name: 'guest-0001', ipHash: 'x', balance: 0 } })
    ).id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // a failed assertion must not leave the throwing hook for the next test
    for (const s of settlers()) s.afterPayouts = undefined;
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  });

  const settlers = () => [appA.get(SettlementService), appB.get(SettlementService)];

  // One gift's worth of rows, as WalletService writes them: 100 coins, 60 to the host.
  async function seedGift(roomId: string, createdAt: Date, settledRunId: string | null = null) {
    const tapId = randomUUID();
    await prisma.gift.create({
      data: { tapId, roomId, guestId, giftId: 'rose', coins: 100, createdAt },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        { tapId, account: `guest:${guestId}`, amount: -100, createdAt },
        { tapId, account: `host:${roomId}`, amount: 60, createdAt },
        { tapId, account: 'platform', amount: 40, createdAt },
      ],
    });
    // WalletService omits the field, so unsettled rows have no settledRunId at all
    await prisma.hostEarning.create({
      data: { tapId, roomId, amount: 60, createdAt, ...(settledRunId && { settledRunId }) },
    });
    return tapId;
  }

  async function seedEarnings(n: number) {
    for (let i = 0; i < n; i++) await seedGift(rooms[i % 2].id, new Date());
  }

  async function ledgerSum() {
    const sum = await prisma.ledgerEntry.aggregateRaw({
      pipeline: [{ $group: { _id: null, total: { $sum: '$amount' } } }],
    });
    return (sum[0] as { total: number } | undefined)?.total ?? 0;
  }

  describe('settlement', () => {
    it('settles 30 earnings once when both replicas fire at the same time', async () => {
      await seedEarnings(30);

      const results = await Promise.all(settlers().map((s) => s.runOnce()));

      const runs = results.filter((r) => r !== null);
      expect(runs).toHaveLength(1);
      expect(['api-1', 'api-2']).toContain(runs[0]!.replica);
      expect(runs[0]).toMatchObject({ rows: 30, total: 30 * 60 });

      const payouts = await prisma.payout.findMany();
      expect(payouts).toHaveLength(2);
      expect(payouts.every((p) => p.runId === runs[0]!.id)).toBe(true);
      expect(payouts.reduce((s, p) => s + p.amount, 0)).toBe(30 * 60);
      expect(payouts.map((p) => p.amount)).toEqual([900, 900]);
      expect((await prisma.hostEarning.findMany()).filter((e) => !e.settledRunId).length).toBe(0);
      expect(await prisma.settlementRun.count()).toBe(1);
    });

    it('settles nothing on a second pass and writes no run', async () => {
      await seedEarnings(30);
      await settlers()[0].runOnce();

      expect(await settlers()[1].runOnce()).toBeNull();
      expect(await settlers()[0].runOnce()).toBeNull();

      expect(await prisma.settlementRun.count()).toBe(1);
      expect(await prisma.payout.count()).toBe(2);
    });

    it('takes at most 500 earnings per pass', async () => {
      const roomId = rooms[0].id;
      await prisma.hostEarning.createMany({
        data: Array.from({ length: 520 }, () => ({
          tapId: randomUUID(),
          roomId,
          amount: 3,
        })),
      });

      const first = await settlers()[0].runOnce();
      expect(first).toMatchObject({ rows: 500, total: 1500 });
      const second = await settlers()[1].runOnce();
      expect(second).toMatchObject({ rows: 20, total: 60 });
      expect((await prisma.hostEarning.findMany()).filter((e) => !e.settledRunId).length).toBe(0);
    });

    it('returns null while another holder has the lock, without waiting', async () => {
      await seedEarnings(4);
      const held = await appA.get<Redlock>(REDLOCK).acquire(['job:settlement'], 10_000);

      const started = Date.now();
      expect(await settlers()[1].runOnce()).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await prisma.settlementRun.count()).toBe(0);

      await held.release();
      expect(await settlers()[1].runOnce()).toMatchObject({ rows: 4, replica: 'api-2' });
    });

    it('rolls everything back when the run fails after the payouts are written', async () => {
      await seedEarnings(30);
      const [a] = settlers();
      a.afterPayouts = () => {
        throw new Error('forced');
      };

      await expect(a.runOnce()).rejects.toThrow('forced');

      expect(await prisma.payout.count()).toBe(0);
      expect(await prisma.settlementRun.count()).toBe(0);
      expect((await prisma.hostEarning.findMany()).filter((e) => !e.settledRunId).length).toBe(30);

      // the lock was released, so the retry is not stuck behind it
      a.afterPayouts = undefined;
      expect(await a.runOnce()).toMatchObject({ rows: 30 });
    });

    it('reports the run to the events feed', async () => {
      await seedEarnings(30);
      const emit = jest.spyOn(appA.get(EventsService), 'emit');

      await settlers()[0].runOnce();

      expect(emit).toHaveBeenCalledTimes(1);
      const e = emit.mock.calls[0][0];
      expect(e).toMatchObject({ kind: 'settlement', replica: 'api-1' });
      expect(e.text).toMatch(/^settlement · 2 rooms · 30 earnings · 1800 coins · \d+ ms · api-1$/);
    });
  });

  describe('retention', () => {
    const retention = () => appA.get(RetentionService);

    it('rolls gifts older than 24 h into DailyStat and keeps the ledger at zero', async () => {
      const run = await prisma.settlementRun.create({
        data: { replica: 'api-1', startedAt: new Date(), finishedAt: new Date(), rows: 0, total: 0 },
      });
      // two on one UTC day, one on the next, so the per-day split is checked
      const day1 = Date.UTC(2026, 9, 1, 10);
      const day2 = Date.UTC(2026, 9, 2, 10);
      jest.spyOn(appA.get(CLOCK), 'now').mockReturnValue(day2 + 30 * HOUR);
      await seedGift(rooms[0].id, new Date(day1), run.id);
      await seedGift(rooms[0].id, new Date(day1 + HOUR), run.id);
      await seedGift(rooms[1].id, new Date(day2), run.id);
      const recent = await seedGift(rooms[0].id, new Date(day2 + 29 * HOUR), run.id);

      const result = await retention().runOnce();

      expect(result).toEqual({ gifts: 3, entries: 9, coins: 300 });
      expect(await prisma.gift.findMany()).toMatchObject([{ tapId: recent }]);
      expect(await prisma.ledgerEntry.count()).toBe(3);
      expect(await prisma.hostEarning.count()).toBe(1);
      expect(await ledgerSum()).toBe(0);

      const stats = await prisma.dailyStat.findMany({ orderBy: { day: 'asc' } });
      expect(stats).toMatchObject([
        { day: '2026-10-01', gifts: 2, coins: 200 },
        { day: '2026-10-02', gifts: 1, coins: 100 },
      ]);
    });

    it('adds to an existing DailyStat row instead of replacing it', async () => {
      const old = new Date(Date.now() - 30 * HOUR);
      const run = await prisma.settlementRun.create({
        data: { replica: 'api-1', startedAt: new Date(), finishedAt: new Date(), rows: 0, total: 0 },
      });
      const day = old.toISOString().slice(0, 10);
      await prisma.dailyStat.create({ data: { day, gifts: 5, coins: 500 } });
      await seedGift(rooms[0].id, old, run.id);

      await retention().runOnce();

      expect(await prisma.dailyStat.findUniqueOrThrow({ where: { day } })).toMatchObject({
        gifts: 6,
        coins: 600,
      });
    });

    it('keeps old groups whose earning is not settled, and the payout history', async () => {
      const old = new Date(Date.now() - 30 * HOUR);
      const run = await prisma.settlementRun.create({
        data: { replica: 'api-1', startedAt: new Date(), finishedAt: new Date(), rows: 1, total: 60 },
      });
      await prisma.payout.create({ data: { runId: run.id, roomId: rooms[0].id, amount: 60 } });
      await seedGift(rooms[0].id, old, run.id);
      const pending = await seedGift(rooms[0].id, old);

      const result = await retention().runOnce();

      expect(result).toMatchObject({ gifts: 1, entries: 3 });
      expect(await prisma.gift.findMany()).toMatchObject([{ tapId: pending }]);
      expect(await prisma.ledgerEntry.count({ where: { tapId: pending } })).toBe(3);
      expect(await prisma.hostEarning.findMany()).toMatchObject([{ tapId: pending }]);
      expect(await prisma.payout.count()).toBe(1);
      expect(await prisma.settlementRun.count()).toBe(1);
      expect(await ledgerSum()).toBe(0);
    });

    it('ages data through the clock, not the wall time', async () => {
      await seedEarnings(5);
      await settlers()[0].runOnce();
      jest.spyOn(appA.get(CLOCK), 'now').mockReturnValue(Date.now() + 25 * HOUR);

      expect(await retention().runOnce()).toMatchObject({ gifts: 5, entries: 15, coins: 500 });
      expect(await prisma.gift.count()).toBe(0);
    });

    it('does nothing and stays quiet when no group is old enough', async () => {
      await seedEarnings(5);
      const emit = jest.spyOn(appA.get(EventsService), 'emit');

      expect(await retention().runOnce()).toEqual({ gifts: 0, entries: 0, coins: 0 });

      expect(await prisma.gift.count()).toBe(5);
      expect(emit).not.toHaveBeenCalled();
    });

    it('returns null while another replica holds job:retention', async () => {
      const held = await appA.get<Redlock>(REDLOCK).acquire(['job:retention'], 10_000);
      expect(await appB.get(RetentionService).runOnce()).toBeNull();
      await held.release();
    });
  });
});
