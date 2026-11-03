import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { RoomGateway } from '../realtime/room.gateway';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';
import { AgoraMinutes } from './agora-minutes';
import { bitsPerSecond, ByteSample, fetchOutgoingBytes } from './livekit-metrics';
import { budgetBps, PerViewerBps, project } from './projection';
import { pruneReports, roomEgress } from './reports';

const SAMPLE_MS = 10_000;
// Two buckets long, so a replica whose clock runs a little behind still finds
// the claim and does not take the next bucket's sample early.
const BUCKET_CLAIM_MS = 20_000;
const SERIES_KEEP = 360;

export type SeriesPoint = {
  t: number;
  // Measured at LiveKit; null when it could not be read or has no baseline yet.
  livekitBps: number | null;
  // What this server would push if the video rooms were self-hosted: the sum
  // of what the video viewers report receiving.
  wouldBeVideoBps: number;
  audioReportedBps: number;
};

export type RateSource = {
  bps: number;
  // 'live' is the average of viewers present now; 'last' is the most recent
  // report ever made for the engine, kept for when nobody is watching.
  source: 'live' | 'last';
  at: number;
};

@Injectable()
export class EgressService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly minutes: AgoraMinutes,
    private readonly gateway: RoomGateway,
    private readonly inflight: Inflight,
  ) {}

  // Every replica runs this on its own timer, each with its own phase, so a
  // lock would only stop overlap: replica A finishes and releases, replica B
  // fires 3 s later and samples again. Claiming the 10 s slot of the wall
  // clock instead means one sample per slot however many replicas there are,
  // and nothing is released so a late replica still finds it taken.
  @Interval(SAMPLE_MS)
  sample(): Promise<boolean> {
    const run = this.sampleSlot();
    this.inflight.track(run);
    return run;
  }

  async bandwidth() {
    const now = this.clock.now();
    const [raw, rooms, agora] = await Promise.all([
      this.redis.lrange('eg:series', 0, -1),
      this.liveRooms(now),
      this.minutes.usage(),
    ]);
    const rates: { agora?: RateSource; livekit?: RateSource } = {};
    const perViewer: PerViewerBps = {};
    for (const engine of ['agora', 'livekit'] as const) {
      const rate = await this.perViewerRate(engine, rooms, now);
      if (!rate) continue;
      rates[engine] = rate;
      perViewer[engine] = rate.bps;
    }
    const budget = budgetBps(Number(this.config.getOrThrow('BUDGET_TB_MONTH')));
    return {
      series: raw.map((p) => JSON.parse(p) as SeriesPoint),
      projection: { ...project(perViewer, budget), perViewer: rates },
      budgetBps: budget,
      agora,
    };
  }

  private async perViewerRate(
    engine: 'agora' | 'livekit',
    rooms: { engine: string; egress: { receiving: number; totalBps: number } }[],
    now: number,
  ): Promise<RateSource | null> {
    const mine = rooms.filter((r) => r.engine === engine);
    // Only viewers who are receiving something: one still waiting for the
    // stream reports 0, and averaging it in would halve the cost of the rest.
    const receiving = mine.reduce((n, r) => n + r.egress.receiving, 0);
    if (receiving) {
      const total = mine.reduce((sum, r) => sum + r.egress.totalBps, 0);
      return { bps: total / receiving, source: 'live', at: now };
    }
    // Nobody receiving right now: the last report still says what one viewer
    // of this engine costs, which is all a projection needs.
    const last = await this.redis.get(`eg:last:${engine}`);
    if (!last) return null;
    const [bps, at] = last.split('|').map(Number);
    return bps ? { bps, source: 'last', at } : null;
  }

  private async liveRooms(now: number) {
    const rooms = await this.prisma.room.findMany({
      where: { status: 'LIVE' },
      select: { id: true, kind: true, engine: true },
    });
    return Promise.all(
      rooms.map(async (r) => ({ ...r, egress: await roomEgress(this.redis, r.id, now) })),
    );
  }

  private async sampleSlot(): Promise<boolean> {
    const now = this.clock.now();
    const slot = Math.floor(now / SAMPLE_MS);
    const claimed = await this.redis.set(`job:sampler:${slot}`, '1', 'PX', BUCKET_CLAIM_MS, 'NX');
    if (!claimed) return false;
    await this.take(now);
    return true;
  }

  private async take(now: number) {
    const rooms = await this.liveRooms(now);
    await Promise.all(rooms.map((r) => pruneReports(this.redis, r.id, now)));
    const reported = (kind: 'VIDEO' | 'AUDIO') =>
      rooms.filter((r) => r.kind === kind).reduce((sum, r) => sum + r.egress.totalBps, 0);

    const point: SeriesPoint = {
      t: now,
      livekitBps: await this.measureLivekit(now),
      wouldBeVideoBps: reported('VIDEO'),
      audioReportedBps: reported('AUDIO'),
    };
    await this.redis
      .multi()
      .rpush('eg:series', JSON.stringify(point))
      .ltrim('eg:series', -SERIES_KEEP, -1)
      .exec();

    // Pushed every tick so a viewer whose phone died shows up as gone without
    // anyone joining or leaving.
    const counts = await Promise.all(rooms.map((r) => viewerCount(this.redis, r.id, now)));
    rooms.forEach((r, i) => this.gateway.emitToRoom(r.id, 'viewers', { count: counts[i] }));

    await this.billAgoraMinute(rooms.map((r, i) => ({ ...r, viewers: counts[i] })), now);
  }

  // Agora bills per participant per minute, and the house host is a
  // participant while it publishes (Task 12 sets house:on:<roomId>). The
  // minute is claimed by wall-clock time, not counted in ticks: replicas and
  // retried ticks cannot bill it twice, and a tick that failed does not make
  // the minute vanish, because the next tick of that minute claims it. The
  // claim is only taken when somebody is there, so an empty first tick does
  // not use up the minute.
  private async billAgoraMinute(
    rooms: { id: string; kind: string; viewers: number }[],
    now: number,
  ) {
    const video = rooms.filter((r) => r.kind === 'VIDEO');
    const hosts = await Promise.all(video.map((r) => this.redis.exists(`house:on:${r.id}`)));
    const total = video.reduce((sum, r, i) => sum + r.viewers + hosts[i], 0);
    if (total === 0) return;
    const minute = new Date(now).toISOString().slice(0, 16);
    if (!(await this.redis.set(`agora:billed:${minute}`, '1', 'EX', 120, 'NX'))) return;
    await this.minutes.add(total);
  }

  // The previous reading lives in Redis because the replica that samples
  // changes from slot to slot. It expires, so a long gap between samples gives
  // a gap in the line instead of one flat average across it.
  private async measureLivekit(now: number): Promise<number | null> {
    const host = this.config.get<string>('LIVEKIT_HOST');
    const bytes = host ? await fetchOutgoingBytes(host) : null;
    if (bytes === null) return null;

    const saved = await this.redis.get('eg:lk:prev');
    const prev = saved ? (JSON.parse(saved) as ByteSample) : null;
    const current: ByteSample = { bytes, t: now };
    await this.redis.set('eg:lk:prev', JSON.stringify(current), 'EX', 60);
    return bitsPerSecond(prev, current);
  }
}
