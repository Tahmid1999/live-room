import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { RoomGateway } from '../realtime/room.gateway';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';
import { SeatSweep } from '../rooms/seat-sweep';
import { bitsPerSecond, ByteSample, bytesSent, fetchOutgoingBytes } from './livekit-metrics';
import { budgetBps, PerViewerBps, project } from './projection';
import { liveRate } from './rate';
import { pruneReports, roomEgress } from './reports';
import { KEEP_SEC, TransferBudget } from './transfer-budget';

const SAMPLE_MS = 10_000;
// Two buckets long, so a replica whose clock runs a little behind still finds
// the claim and does not take the next bucket's sample early.
const BUCKET_CLAIM_MS = 20_000;
const SERIES_KEEP = 360;
// The chart's baseline expires quickly; the budget's does not (see readNode).
const CHART_PREV = 'eg:lk:prev';
const BUDGET_PREV = 'eg:lk:month-prev';
const KINDS = ['VIDEO', 'AUDIO'] as const;
type Kind = (typeof KINDS)[number];
type LiveRoom = { id: string; kind: Kind; egress: { rates: number[]; totalBps: number } };
// The projection and the stored last rates are keyed in lower case.
const lower = (kind: Kind) => kind.toLowerCase() as 'video' | 'audio';

export type SeriesPoint = {
  t: number;
  // Measured at LiveKit; null when it could not be read or has no baseline yet.
  livekitBps: number | null;
  // The sum of what the viewers in each kind of room report receiving. The
  // node's counter covers both kinds at once, so the split only exists here.
  videoReportedBps: number;
  audioReportedBps: number;
};

export type RateSource = {
  bps: number;
  // 'live' is worked out from the viewers present now (see liveRate); 'last'
  // is the latest live rate the sampler kept, for when nobody is watching.
  source: 'live' | 'last';
  at: number;
};

@Injectable()
export class EgressService {
  private readonly log = new Logger(EgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly budget: TransferBudget,
    private readonly gateway: RoomGateway,
    private readonly inflight: Inflight,
    private readonly seatSweep: SeatSweep,
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
    const [raw, rooms, transfer] = await Promise.all([
      this.redis.lrange('eg:series', 0, -1),
      this.liveRooms(now),
      this.budget.usage(),
    ]);
    // Points written before reports were grouped by kind carry other field
    // names; they stay in the chart as zeros until they scroll out of the hour.
    const series = raw.map((p) => {
      const old = JSON.parse(p) as Partial<SeriesPoint>;
      return {
        t: old.t!,
        livekitBps: old.livekitBps ?? null,
        videoReportedBps: old.videoReportedBps ?? 0,
        audioReportedBps: old.audioReportedBps ?? 0,
      } satisfies SeriesPoint;
    });
    const rates: { video?: RateSource; audio?: RateSource } = {};
    const perViewer: PerViewerBps = {};
    for (const kind of KINDS) {
      const rate = await this.perViewerRate(kind, rooms, now);
      if (!rate) continue;
      rates[lower(kind)] = rate;
      perViewer[lower(kind)] = rate.bps;
    }
    const budgetRate = budgetBps(Number(this.config.getOrThrow('BUDGET_TB_MONTH')));
    return {
      series,
      projection: { ...project(perViewer, budgetRate), perViewer: rates },
      budgetBps: budgetRate,
      transfer,
    };
  }

  private async perViewerRate(kind: Kind, rooms: LiveRoom[], now: number): Promise<RateSource | null> {
    const live = this.liveRateOf(kind, rooms);
    if (live) return { bps: live, source: 'live', at: now };
    // Nobody receiving right now: the last live rate still says what one
    // viewer of this kind costs, which is all a projection needs.
    const last = await this.redis.get(`eg:last:${lower(kind)}`);
    if (!last) return null;
    const [bps, at] = last.split('|').map(Number);
    return bps ? { bps, source: 'last', at } : null;
  }

  private liveRateOf(kind: Kind, rooms: LiveRoom[]) {
    return liveRate(rooms.filter((r) => r.kind === kind).flatMap((r) => r.egress.rates));
  }

  private async liveRooms(now: number) {
    const rooms = await this.prisma.room.findMany({
      where: { status: 'LIVE' },
      select: { id: true, kind: true },
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
    const reported = (kind: Kind) =>
      rooms.filter((r) => r.kind === kind).reduce((sum, r) => sum + r.egress.totalBps, 0);

    // One reading of the node feeds both the chart and the monthly budget.
    const node = await this.readNode(now);
    const point: SeriesPoint = {
      t: now,
      livekitBps: node.bps,
      videoReportedBps: reported('VIDEO'),
      audioReportedBps: reported('AUDIO'),
    };
    const write = this.redis
      .multi()
      .rpush('eg:series', JSON.stringify(point))
      .ltrim('eg:series', -SERIES_KEEP, -1);
    // Kept only from a rate that went through liveRate, so a lone forged
    // report cannot become the figure shown once everybody has left.
    for (const kind of KINDS) {
      const live = this.liveRateOf(kind, rooms);
      if (live) write.set(`eg:last:${lower(kind)}`, `${live}|${now}`);
    }
    await write.exec();
    if (node.reading) {
      if (node.bytes !== null) await this.budget.add(node.bytes);
      // Only once the bytes are counted: if the series write or the add threw,
      // this line never ran and the next slot measures from the old reading.
      await this.redis.set(BUDGET_PREV, JSON.stringify(node.reading), 'EX', KEEP_SEC);
    }

    // Pushed every tick so a viewer whose phone died shows up as gone without
    // anyone joining or leaving. Before the sweep: it talks to LiveKit, and a
    // node that hangs must not hold the counts back.
    const counts = await Promise.all(rooms.map((r) => viewerCount(this.redis, r.id, now)));
    rooms.forEach((r, i) => this.gateway.emitToRoom(r.id, 'viewers', { count: counts[i] }));

    // After the budget is up to date, because the pause is one of the reasons
    // a seat goes. A sweep failure must not cost the point written above.
    try {
      await this.seatSweep.sweep(now);
    } catch (err) {
      this.log.warn(`seat sweep failed: ${(err as Error).message}`);
    }
  }

  // The previous reading lives in Redis because the replica that samples
  // changes from slot to slot. The chart and the budget keep separate ones.
  // The chart's expires after a minute, so a long gap gives a gap in the line
  // instead of one flat average across it. The budget's lives as long as the
  // month counter and only moves once its bytes are counted, so after a gap
  // the whole delta since the last good reading is added: undercounting is the
  // unsafe direction for a threshold that pauses video.
  private async readNode(
    now: number,
  ): Promise<{ bps: number | null; bytes: number | null; reading: ByteSample | null }> {
    // In production LiveKit is on another machine, behind a proxy that lets
    // only the API's address read this.
    const url = this.config.get<string>('LIVEKIT_METRICS_URL');
    const bytes = url ? await fetchOutgoingBytes(url) : null;
    if (bytes === null) return { bps: null, bytes: null, reading: null };

    const [chartPrev, budgetPrev] = await this.redis.mget(CHART_PREV, BUDGET_PREV);
    const current: ByteSample = { bytes, t: now };
    await this.redis.set(CHART_PREV, JSON.stringify(current), 'EX', 60);
    return {
      bps: bitsPerSecond(chartPrev ? (JSON.parse(chartPrev) as ByteSample) : null, current),
      bytes: bytesSent(budgetPrev ? (JSON.parse(budgetPrev) as ByteSample) : null, current),
      reading: current,
    };
  }
}
