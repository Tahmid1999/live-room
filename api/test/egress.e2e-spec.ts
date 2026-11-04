import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { EgressService } from '../src/egress/egress.service';
import { TransferBudget } from '../src/egress/transfer-budget';
import { roomEgress } from '../src/egress/reports';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, Client, flushRedis, joinWithRejoin, resetDb, urlOf } from './helpers';

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const counter = (bytes: number) =>
  [
    'livekit_packet_bytes{country="",direction="incoming",transmission="udp"} 7',
    `livekit_packet_bytes{country="",direction="outgoing",transmission="udp"} ${bytes}`,
  ].join('\n');

describe('egress', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let egress: EgressService;
  let video: Room;
  let audio: Room;
  let clients: Client[];
  // Every time read in the app goes through CLOCK, so a test moves time by
  // changing this instead of waiting.
  let at: number;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
    egress = app.get(EgressService);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    at = Date.now();
    jest.spyOn(app.get(CLOCK), 'now').mockImplementation(() => at);
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
    await app.close();
  });

  const server = () => app.getHttpServer();
  const month = () => new Date(at).toISOString().slice(0, 7);

  async function newGuest() {
    const res = await request(server()).get('/me').expect(200);
    const cookie = (res.headers['set-cookie'][0] as string).split(';')[0];
    return { cookie, id: res.body.id as string };
  }

  async function watch(room: Room, bps?: number) {
    const guest = await newGuest();
    const client = await joinWithRejoin(urlOf(app), guest.cookie, room.id);
    clients.push(client);
    await client.waitFor('chat:history');
    if (bps !== undefined) client.socket.emit('stats', { bps });
    return { ...guest, client };
  }

  const reported = (room: Room, viewers: number) =>
    until(async () => (await roomEgress(redis, room.id, at)).viewers === viewers);

  describe('reports', () => {
    it('takes the median of what the viewers in a room report', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await reported(video, 2);
      expect(await roomEgress(redis, video.id, at)).toEqual({
        viewers: 2,
        receiving: 2,
        totalBps: 2.8e6,
        perViewerBps: 1.4e6,
        rates: [1.2e6, 1.6e6],
      });
    });

    it('leaves a viewer still waiting for the stream out of the per-viewer figure', async () => {
      await watch(video, 1.2e6);
      await watch(video, 0);
      await reported(video, 2);
      expect(await roomEgress(redis, video.id, at)).toEqual({
        viewers: 2,
        receiving: 1,
        totalBps: 1.2e6,
        perViewerBps: 1.2e6,
        rates: [1.2e6],
      });
    });

    it('stops counting a viewer 15 s after their last report', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await reported(video, 2);
      at += 14_000;
      expect((await roomEgress(redis, video.id, at)).viewers).toBe(2);
      at += 2_000;
      expect(await roomEgress(redis, video.id, at)).toEqual({
        viewers: 0,
        receiving: 0,
        totalBps: 0,
        perViewerBps: 0,
        rates: [],
      });
    });

    it('counts a report as presence in the room', async () => {
      const { id } = await watch(video, 900_000);
      await reported(video, 1);
      expect(await redis.zscore(`viewers:${video.id}`, id)).toBe(String(at));
    });

    it('leaves the remembered rate to the sampler, not to a single report', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      await watch(video, 1.2e6);
      await watch(audio, 48_000);
      await reported(video, 1);
      await reported(audio, 1);
      expect(await redis.exists('eg:last:video', 'eg:last:audio')).toBe(0);
      await egress.sample();
      expect(await redis.get('eg:last:video')).toBe(`1200000|${at}`);
      expect(await redis.get('eg:last:audio')).toBe(`48000|${at}`);
    });

    it('ignores a report from a socket that has not joined a room', async () => {
      const guest = await newGuest();
      const client = await joinWithRejoin(urlOf(app), guest.cookie, video.id);
      clients.push(client);
      client.socket.emit('stats', { bps: 5 });
      // Same socket, same order: once the join is answered the stats are long handled.
      await client.waitFor('chat:history');
      expect(await redis.exists(`eg:${video.id}`, 'eg:last:video')).toBe(0);
    });

    it('clamps a report to 0..3 Mbps for video and 0..300 kbps for audio', async () => {
      const big = await watch(video, 9e9);
      const negative = await watch(video, -50);
      const loud = await watch(audio, 20e6);
      await reported(video, 2);
      await reported(audio, 1);
      expect(await redis.hget(`eg:${video.id}`, big.id)).toBe(`3000000|${at}`);
      expect(await redis.hget(`eg:${video.id}`, negative.id)).toBe(`0|${at}`);
      expect(await redis.hget(`eg:${audio.id}`, loud.id)).toBe(`300000|${at}`);
    });

    it('ignores a bps that is not a number', async () => {
      const { client, id } = await watch(video);
      client.socket.emit('stats', { bps: '1200' });
      client.socket.emit('stats', { bps: null });
      client.socket.emit('stats', {});
      // An ignored report also costs no rate-limit slot, so a good one right
      // behind them is recorded; one that was let through would have used it up.
      client.socket.emit('stats', { bps: 7 });
      await reported(video, 1);
      expect(await redis.hget(`eg:${video.id}`, id)).toBe(`7|${at}`);
    });

    it('drops a viewer from the egress sum the moment they leave', async () => {
      const { client } = await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await reported(video, 2);
      client.socket.emit('room:leave');
      await reported(video, 1);
      expect(await roomEgress(redis, video.id, at)).toMatchObject({ viewers: 1, totalBps: 1.6e6 });
    });

    it('takes one report per guest per 2 s', async () => {
      const { client, id } = await watch(video, 100_000);
      await reported(video, 1);
      client.socket.emit('stats', { bps: 200_000 });
      await until(async () => (await redis.get(`stats:${id}`)) === '2');
      expect(await redis.hget(`eg:${video.id}`, id)).toBe(`100000|${at}`);
    });
  });

  describe('transfer budget', () => {
    it('starts a fresh count in a new month', async () => {
      await redis.set(`eg:month:${month()}`, String(0.9 * 20e12));
      at = Date.UTC(new Date(at).getUTCFullYear() + 1, 0, 1);
      await request.agent(server()).post(`/rooms/${video.id}/join`).expect(200);
    });

    it('is paused from 80% of the budget, read off the counter', async () => {
      await redis.set(`eg:month:${month()}`, String(0.8 * 20e12));
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.transfer).toMatchObject({
        usedBytes: 16e12,
        budgetBytes: 20e12,
        pauseAtBytes: 16e12,
        paused: true,
      });
    });

    it('ignores bytes that are zero, negative or not a number', async () => {
      const budget = app.get(TransferBudget);
      await budget.add(0);
      await budget.add(-5);
      await budget.add(Number.NaN);
      await budget.add(Infinity);
      expect(await redis.exists(`eg:month:${month()}`, 'eg:month:at')).toBe(0);
    });

    it('keeps a month counter for 40 days', async () => {
      await app.get(TransferBudget).add(100);
      const ttl = await redis.ttl(`eg:month:${month()}`);
      expect(ttl).toBeGreaterThan(39 * 86400);
      expect(ttl).toBeLessThanOrEqual(40 * 86400);
    });
  });

  describe('sampler', () => {
    let metrics: jest.SpyInstance;
    // What the stubbed node reports as sent so far; a test moves it between slots.
    let served: number;

    beforeEach(() => {
      // Slots are cut from the wall clock, so start on a minute boundary to
      // know where the 10 s slots fall.
      at = Math.floor(at / 60_000) * 60_000;
      served = 1_000_000;
      // A fresh Response per call: a body can be read only once.
      metrics = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(counter(served)));
    });

    const series = async () => (await request(server()).get('/bandwidth').expect(200)).body.series;

    async function crowd() {
      const a = await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await watch(audio, 48_000);
      await reported(video, 2);
      await reported(audio, 1);
      return a;
    }

    it('records measured and reported rates side by side', async () => {
      await crowd();
      await egress.sample();
      expect(await series()).toEqual([
        { t: at, livekitBps: null, videoReportedBps: 2.8e6, audioReportedBps: 48_000 },
      ]);
      expect(metrics.mock.calls[0][0]).toBe(process.env.LIVEKIT_METRICS_URL);
    });

    it('measures LiveKit from the counter between two samples', async () => {
      await crowd();
      await egress.sample();
      at += 10_000;
      served = 1_060_000;
      await egress.sample();
      expect((await series())[1].livekitBps).toBe(48_000);
    });

    it('takes the per-viewer rate from the median of the reports, not from the node counter', async () => {
      await watch(audio, 20_000);
      await watch(audio, 20e6);
      await watch(audio, 40_000);
      await reported(audio, 3);
      await egress.sample();
      at += 10_000;
      // 120 kB in 10 s is 96 kbps for the whole node, which says nothing
      // about what one audio viewer receives.
      served = 1_120_000;
      await egress.sample();
      expect(await redis.get('eg:last:audio')).toBe(`40000|${at}`);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.perViewer.audio).toEqual({ bps: 40_000, source: 'live', at });
    });

    it('shows a gap, not a made-up number, when LiveKit cannot be reached', async () => {
      metrics.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await egress.sample();
      expect(await series()).toEqual([
        { t: at, livekitBps: null, videoReportedBps: 0, audioReportedBps: 0 },
      ]);
    });

    it('does not turn a LiveKit restart into a negative rate', async () => {
      await egress.sample();
      at += 10_000;
      served = 500;
      await egress.sample();
      at += 10_000;
      served = 5_500;
      await egress.sample();
      expect((await series()).map((p: any) => p.livekitBps)).toEqual([null, null, 4000]);
    });

    describe('monthly transfer', () => {
      const bandwidth = async () => (await request(server()).get('/bandwidth').expect(200)).body;

      it('adds what the node sent between two slots to the month counter', async () => {
        await egress.sample();
        // The first slot has no baseline, so nothing is counted yet.
        expect(await redis.get(`eg:month:${month()}`)).toBeNull();
        at += 10_000;
        served = 3_000_000;
        await egress.sample();
        expect(await redis.get(`eg:month:${month()}`)).toBe('2000000');
        const { transfer } = await bandwidth();
        expect(transfer).toEqual({
          usedBytes: 2_000_000,
          budgetBytes: 20e12,
          pauseAtBytes: 16e12,
          paused: false,
          measuredAt: at,
        });
      });

      it('adds nothing for a slot where the counter went down', async () => {
        await egress.sample();
        at += 10_000;
        served = 3_000_000;
        await egress.sample();
        const counted = at;
        at += 10_000;
        // LiveKit restarted: the counter starts again from a small number.
        served = 700;
        await egress.sample();
        expect((await bandwidth()).transfer).toMatchObject({ usedBytes: 2_000_000, measuredAt: counted });
        // The next slot measures against the new baseline.
        at += 10_000;
        served = 5_700;
        await egress.sample();
        expect((await bandwidth()).transfer).toMatchObject({ usedBytes: 2_005_000, measuredAt: at });
      });

      it('adds nothing, and moves no timestamp, while the node cannot be read', async () => {
        metrics.mockRejectedValue(new Error('connect ECONNREFUSED'));
        await egress.sample();
        at += 10_000;
        await egress.sample();
        const { transfer } = await bandwidth();
        expect(transfer).toMatchObject({ usedBytes: 0, measuredAt: null });
      });

      it('reports no timestamp before anything has been counted', async () => {
        expect((await bandwidth()).transfer.measuredAt).toBeNull();
      });

      it('pauses once the counter is at 80% of the budget', async () => {
        await redis.set(`eg:month:${month()}`, String(0.8 * 20e12 - 1_000_000));
        await egress.sample();
        at += 10_000;
        served = 3_000_000;
        await egress.sample();
        expect((await bandwidth()).transfer).toMatchObject({ usedBytes: 16e12 + 1_000_000, paused: true });
      });

      it('keeps one counter per UTC month', async () => {
        at = Date.UTC(2031, 0, 31, 23, 59, 50);
        await egress.sample();
        at += 10_000;
        served = 2_000_000;
        await egress.sample();
        expect(at).toBe(Date.UTC(2031, 1, 1));
        expect(await redis.get('eg:month:2031-02')).toBe('1000000');
        expect(await redis.get('eg:month:2031-01')).toBeNull();
      });
    });

    it('keeps the last 360 points', async () => {
      const old = Array.from({ length: 360 }, (_, i) =>
        JSON.stringify({ t: i, livekitBps: 0, videoReportedBps: 0, audioReportedBps: 0 }),
      );
      await redis.rpush('eg:series', ...old);
      await egress.sample();
      const kept = await series();
      expect(kept).toHaveLength(360);
      expect(kept[0].t).toBe(1);
      expect(kept[359].t).toBe(at);
    });

    it('tells every live room its viewer count, including after expiries', async () => {
      const { client } = await crowd();
      const before = client.count('viewers');
      await egress.sample();
      expect(await client.waitFor('viewers', before + 1)).toEqual({ count: 2 });

      at += 16_000;
      await egress.sample();
      expect(await client.waitFor('viewers', before + 2)).toEqual({ count: 0 });
    });

    it('takes one sample per 10 s slot, however many calls land in it', async () => {
      expect(await egress.sample()).toBe(true);
      at += 3_000;
      expect(await egress.sample()).toBe(false);
      at += 6_000;
      expect(await egress.sample()).toBe(false);
      expect(await series()).toHaveLength(1);
      at += 1_000;
      expect(await egress.sample()).toBe(true);
      expect(await series()).toHaveLength(2);
    });

    it('samples every slot, and counts each slot once, across a minute of calls 5 s apart', async () => {
      for (let i = 0; i < 12; i++) {
        await egress.sample();
        at += 5_000;
        served += 1_000;
      }
      expect(await series()).toHaveLength(6);
      // Six slots, five deltas; each slot sees the counter 2,000 higher than the last.
      expect(await redis.get(`eg:month:${month()}`)).toBe('10000');
    });

    it('leaves stale reports alone on a read and lets the sampler prune them', async () => {
      await watch(video, 1.2e6);
      await reported(video, 1);
      at += 20_000;
      await request(server()).get('/bandwidth').expect(200);
      expect(await redis.hlen(`eg:${video.id}`)).toBe(1);
      await egress.sample();
      expect(await redis.hlen(`eg:${video.id}`)).toBe(0);
    });

    describe('with a second replica', () => {
      let other: INestApplication;

      beforeAll(async () => {
        other = await bootApp({ replica: 'b' });
      });

      afterAll(async () => {
        await other.close();
      });

      it('still takes one sample per slot and counts each delta once', async () => {
        jest.spyOn(other.get(CLOCK), 'now').mockImplementation(() => at);
        const a = egress;
        const b = other.get(EgressService);
        const ran: boolean[] = [];
        // Each replica fires every 10 s on its own phase: A on the slot start, B 3 s later.
        for (let slot = 0; slot < 6; slot++) {
          ran.push(await a.sample());
          at += 3_000;
          ran.push(await b.sample());
          at += 7_000;
          served += 1_000;
        }
        expect(ran).toEqual([true, false, true, false, true, false, true, false, true, false, true, false]);
        expect(await series()).toHaveLength(6);
        expect(await redis.get(`eg:month:${month()}`)).toBe('5000');
      });
    });
  });

  describe('a viewer that reports 0 bps', () => {
    beforeEach(() => {
      at = Math.floor(at / 10_000) * 10_000;
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    });

    it('does not overwrite the last real rate', async () => {
      const first = await watch(audio, 48_000);
      await reported(audio, 1);
      await egress.sample();
      await watch(audio, 0);
      first.client.socket.emit('room:leave');
      await until(async () => (await roomEgress(redis, audio.id, at)).receiving === 0);
      at += 10_000;
      await egress.sample();
      expect(await redis.get('eg:last:audio')).toBe(`48000|${at - 10_000}`);
    });

    it('still counts as present and leaves no rate behind on a fresh deploy', async () => {
      await watch(audio, 0);
      await reported(audio, 1);
      await egress.sample();
      expect(await redis.get('eg:last:audio')).toBeNull();
      expect(await roomEgress(redis, audio.id, at)).toMatchObject({ viewers: 1, receiving: 0 });
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection).toEqual({ lines: [], crossing: {}, perViewer: {} });
    });

    it('is left out of the live average', async () => {
      await watch(video, 1.2e6);
      await watch(video, 0);
      await reported(video, 2);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.perViewer.video).toEqual({ bps: 1.2e6, source: 'live', at });
      expect(res.body.projection.crossing.video).toBe(51);
    });

    it('falls back to the last rate when every viewer reports 0', async () => {
      await watch(audio, 48_000);
      await reported(audio, 1);
      await egress.sample();
      at += 20_000;
      const then = at - 20_000;
      await watch(audio, 0);
      await reported(audio, 1);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.perViewer).toEqual({
        audio: { bps: 48_000, source: 'last', at: then },
      });
      expect(res.body.projection.crossing).toEqual({ audio: 1286 });
    });
  });

  describe('GET /bandwidth', () => {
    it('is empty and public before anything is measured', async () => {
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body).toEqual({
        series: [],
        projection: { lines: [], crossing: {}, perViewer: {} },
        budgetBps: 61728395,
        transfer: { usedBytes: 0, budgetBytes: 20e12, pauseAtBytes: 16e12, paused: false, measuredAt: null },
      });
    });

    it('projects the budget crossing from what viewers report', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await watch(audio, 48_000);
      await reported(video, 2);
      await reported(audio, 1);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.crossing).toEqual({ video: 44, audio: 1286 });
      expect(res.body.projection.perViewer).toEqual({
        video: { bps: 1.4e6, source: 'live', at },
        audio: { bps: 48_000, source: 'live', at },
      });
      expect(res.body.projection.lines.map((l: any) => l.kind)).toEqual(['video', 'audio']);
    });

    it('gives each kind its own rate from the reports of its own rooms', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await watch(audio, 40_000);
      await reported(video, 2);
      await reported(audio, 1);
      const { perViewer } = (await request(server()).get('/bandwidth').expect(200)).body.projection;
      expect(perViewer.video).toEqual({ bps: 1.4e6, source: 'live', at });
      expect(perViewer.audio).toEqual({ bps: 40_000, source: 'live', at });
    });

    it('still answers when Redis holds keys and series points from before the budget', async () => {
      await redis.set('eg:last:agora', `1400000|${at}`);
      await redis.set('eg:last:livekit', `48000|${at}`);
      await redis.rpush(
        'eg:series',
        JSON.stringify({ t: at - 10_000, livekitBps: 5, wouldBeVideoBps: 2.8e6, audioReportedBps: 48_000 }),
      );
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.series).toEqual([
        { t: at - 10_000, livekitBps: 5, videoReportedBps: 0, audioReportedBps: 48_000 },
      ]);
      expect(res.body.projection).toEqual({ lines: [], crossing: {}, perViewer: {} });
    });

    it('is not moved by a forged 20 Mbps audio report', async () => {
      for (let i = 0; i < 3; i++) await watch(audio, 48_000);
      await watch(audio, 20e6);
      await reported(audio, 4);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.perViewer.audio).toEqual({ bps: 48_000, source: 'live', at });
      expect(res.body.projection.crossing).toEqual({ audio: 1286 });
    });

    it('takes the median video rate, so one outlier does not move it', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.3e6);
      await watch(video, 20e6);
      await reported(video, 3);
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.perViewer.video).toEqual({ bps: 1.3e6, source: 'live', at });
    });

    it('falls back to the last sampled rate once nobody is watching', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      await watch(audio, 48_000);
      await reported(audio, 1);
      await egress.sample();
      at += 20_000;
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.crossing).toEqual({ audio: 1286 });
      expect(res.body.projection.perViewer).toEqual({
        audio: { bps: 48_000, source: 'last', at: at - 20_000 },
      });
    });
  });
});
