import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { EgressService } from '../src/egress/egress.service';
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
    it('averages what the viewers in a room report', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await reported(video, 2);
      expect(await roomEgress(redis, video.id, at)).toEqual({
        viewers: 2,
        totalBps: 2.8e6,
        perViewerBps: 1.4e6,
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
        totalBps: 0,
        perViewerBps: 0,
      });
    });

    it('counts a report as presence in the room', async () => {
      const { id } = await watch(video, 900_000);
      await reported(video, 1);
      expect(await redis.zscore(`viewers:${video.id}`, id)).toBe(String(at));
    });

    it('remembers the latest rate per engine', async () => {
      await watch(video, 1.2e6);
      await watch(audio, 48_000);
      await until(async () => (await redis.get('eg:last:livekit')) === `48000|${at}`);
      expect(await redis.get('eg:last:agora')).toBe(`1200000|${at}`);
    });

    it('ignores a report from a socket that has not joined a room', async () => {
      const guest = await newGuest();
      const client = await joinWithRejoin(urlOf(app), guest.cookie, video.id);
      clients.push(client);
      client.socket.emit('stats', { bps: 5 });
      // Same socket, same order: once the join is answered the stats are long handled.
      await client.waitFor('chat:history');
      expect(await redis.exists(`eg:${video.id}`, 'eg:last:agora')).toBe(0);
    });

    it('clamps a report to between 0 and 20 Mbps', async () => {
      const big = await watch(video, 9e9);
      const negative = await watch(video, -50);
      await reported(video, 2);
      expect(await redis.hget(`eg:${video.id}`, big.id)).toBe(`20000000|${at}`);
      expect(await redis.hget(`eg:${video.id}`, negative.id)).toBe(`0|${at}`);
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

  describe('agora minutes', () => {
    it('pauses video joins at 80% of the free minutes and keeps audio open', async () => {
      await redis.set(`agora:min:${month()}`, '8000');
      const guest = request.agent(server());
      const res = await guest.post(`/rooms/${video.id}/join`).expect(503);
      expect(res.body).toEqual({ error: 'video paused until the 1st: free Agora minutes used up' });
      await guest.post(`/rooms/${audio.id}/join`).expect(200);
    });

    it('lets video in one minute below the line', async () => {
      await redis.set(`agora:min:${month()}`, '7999');
      await request.agent(server()).post(`/rooms/${video.id}/join`).expect(200);
    });

    it('starts a fresh count in a new month', async () => {
      await redis.set(`agora:min:${month()}`, '9000');
      at = Date.UTC(new Date(at).getUTCFullYear() + 1, 0, 1);
      await request.agent(server()).post(`/rooms/${video.id}/join`).expect(200);
    });
  });

  describe('sampler', () => {
    let metrics: jest.SpyInstance;

    beforeEach(() => {
      // Slots and billing minutes are cut from the wall clock, so start on a
      // minute boundary to know where the 10 s slots fall.
      at = Math.floor(at / 60_000) * 60_000;
      metrics = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(counter(1_000_000)));
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
        { t: at, livekitBps: null, wouldBeVideoBps: 2.8e6, audioReportedBps: 48_000 },
      ]);
      expect(metrics.mock.calls[0][0]).toBe(`http://${process.env.LIVEKIT_HOST}:6789/metrics`);
    });

    it('measures LiveKit from the counter between two samples', async () => {
      await crowd();
      await egress.sample();
      at += 10_000;
      metrics.mockResolvedValue(new Response(counter(1_060_000)));
      await egress.sample();
      expect((await series())[1].livekitBps).toBe(48_000);
    });

    it('shows a gap, not a made-up number, when LiveKit cannot be reached', async () => {
      metrics.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await egress.sample();
      expect(await series()).toEqual([
        { t: at, livekitBps: null, wouldBeVideoBps: 0, audioReportedBps: 0 },
      ]);
    });

    it('does not turn a LiveKit restart into a negative rate', async () => {
      await egress.sample();
      at += 10_000;
      metrics.mockResolvedValue(new Response(counter(500)));
      await egress.sample();
      at += 10_000;
      metrics.mockResolvedValue(new Response(counter(5_500)));
      await egress.sample();
      expect((await series()).map((p: any) => p.livekitBps)).toEqual([null, null, 4000]);
    });

    it('keeps the last 360 points', async () => {
      const old = Array.from({ length: 360 }, (_, i) =>
        JSON.stringify({ t: i, livekitBps: 0, wouldBeVideoBps: 0, audioReportedBps: 0 }),
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

    it('bills the viewers plus the house host once for the minute', async () => {
      await crowd();
      await redis.set(`house:on:${video.id}`, '1');
      await egress.sample();
      expect(await redis.get(`agora:min:${month()}`)).toBe('3');
      // five more ticks in the same minute add nothing
      for (let i = 0; i < 5; i++) {
        at += 10_000;
        await egress.sample();
      }
      expect(await redis.get(`agora:min:${month()}`)).toBe('3');
      at += 10_000;
      await redis.zadd(`viewers:${video.id}`, at, 'g-late');
      // the next minute: the one viewer still present plus the host
      await egress.sample();
      expect(await redis.get(`agora:min:${month()}`)).toBe('5');
    });

    it('does not bill the host minute while the house is not publishing, nor audio at all', async () => {
      await crowd();
      await egress.sample();
      expect(await redis.get(`agora:min:${month()}`)).toBe('2');
    });

    it('keeps the minute open for the first tick that has somebody in it', async () => {
      await egress.sample();
      expect(await redis.get(`agora:min:${month()}`)).toBeNull();
      await crowd();
      at += 10_000;
      await egress.sample();
      expect(await redis.get(`agora:min:${month()}`)).toBe('2');
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

    it('samples every slot and bills once across a minute of calls 5 s apart', async () => {
      await crowd();
      for (let i = 0; i < 12; i++) {
        await egress.sample();
        at += 5_000;
        // Keep the viewers alive; the question here is billing, not expiry.
        await redis.zadd(`viewers:${video.id}`, at, 'keep');
      }
      expect(await series()).toHaveLength(6);
      expect(await redis.get(`agora:min:${month()}`)).toBe('2');
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

      it('still takes one sample per slot and bills the minute once', async () => {
        jest.spyOn(other.get(CLOCK), 'now').mockImplementation(() => at);
        const a = egress;
        const b = other.get(EgressService);
        await crowd();
        const ran: boolean[] = [];
        // Each replica fires every 10 s on its own phase: A on the slot start, B 3 s later.
        for (let slot = 0; slot < 6; slot++) {
          ran.push(await a.sample());
          at += 3_000;
          ran.push(await b.sample());
          at += 7_000;
          await redis.zadd(`viewers:${video.id}`, at, 'keep');
        }
        expect(ran).toEqual([true, false, true, false, true, false, true, false, true, false, true, false]);
        expect(await series()).toHaveLength(6);
        expect(await redis.get(`agora:min:${month()}`)).toBe('2');
      });
    });
  });

  describe('GET /bandwidth', () => {
    it('is empty and public before anything is measured', async () => {
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body).toEqual({
        series: [],
        projection: { lines: [], crossing: {}, perViewer: {} },
        budgetBps: 61728395,
        agora: { used: 0, free: 10000, pauseAt: 8000, paused: false },
      });
    });

    it('projects the budget crossing from what viewers report', async () => {
      await watch(video, 1.2e6);
      await watch(video, 1.6e6);
      await watch(audio, 48_000);
      await reported(video, 2);
      await reported(audio, 1);
      await redis.set(`agora:min:${month()}`, '8123');
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.crossing).toEqual({ agora: 44, livekit: 1286 });
      expect(res.body.projection.perViewer).toEqual({
        agora: { bps: 1.4e6, source: 'live', at },
        livekit: { bps: 48_000, source: 'live', at },
      });
      expect(res.body.projection.lines.map((l: any) => l.engine)).toEqual(['agora', 'livekit']);
      expect(res.body.agora).toEqual({ used: 8123, free: 10000, pauseAt: 8000, paused: true });
    });

    it('falls back to the latest report once nobody is watching', async () => {
      await watch(audio, 48_000);
      await reported(audio, 1);
      at += 20_000;
      const res = await request(server()).get('/bandwidth').expect(200);
      expect(res.body.projection.crossing).toEqual({ livekit: 1286 });
      expect(res.body.projection.perViewer).toEqual({
        livekit: { bps: 48_000, source: 'last', at: at - 20_000 },
      });
    });
  });
});
