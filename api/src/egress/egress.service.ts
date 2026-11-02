import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import Redis from 'ioredis';
import Redlock from 'redlock';
import { Clock, CLOCK } from '../clock';
import { runLocked } from '../jobs/run-locked';
import { viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { RoomGateway } from '../realtime/room.gateway';
import { Inflight } from '../redis/inflight';
import { REDIS, REDLOCK } from '../redis/redis.module';
import { AgoraMinutes } from './agora-minutes';
import { bitsPerSecond, ByteSample, fetchOutgoingBytes } from './livekit-metrics';
import { budgetBps, PerViewerBps, project } from './projection';
import { roomEgress } from './reports';

const SAMPLE_MS = 10_000;
// Under the interval, so a replica that died mid-run does not hold the next tick.
const LOCK_MS = 9_000;
const SERIES_KEEP = 360;
// 6 ticks of 10 s is one Agora minute.
const TICKS_PER_MINUTE = 6;

export type SeriesPoint = {
  t: number;
  // Measured at LiveKit; null when it could not be read or has no baseline yet.
  livekitBps: number | null;
  // What this server would push if the video rooms were self-hosted: the sum
  // of what the video viewers report receiving.
  wouldBeVideoBps: number;
  audioReportedBps: number;
};

@Injectable()
export class EgressService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDLOCK) private readonly redlock: Redlock,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly minutes: AgoraMinutes,
    private readonly gateway: RoomGateway,
    private readonly inflight: Inflight,
  ) {}

  @Interval(SAMPLE_MS)
  sample() {
    const run = runLocked(this.redlock, 'job:sampler', () => this.take(), LOCK_MS);
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
    const perViewer: PerViewerBps = {};
    for (const engine of ['agora', 'livekit'] as const) {
      const mine = rooms.filter((r) => r.engine === engine);
      const viewers = mine.reduce((n, r) => n + r.egress.viewers, 0);
      // Nobody watching right now: the last report still says what one viewer
      // of this engine costs, which is all a projection needs.
      const rate = viewers
        ? mine.reduce((sum, r) => sum + r.egress.totalBps, 0) / viewers
        : Number(await this.redis.get(`eg:last:${engine}`));
      if (rate) perViewer[engine] = rate;
    }
    const budget = budgetBps(Number(this.config.getOrThrow('BUDGET_TB_MONTH')));
    return {
      series: raw.map((p) => JSON.parse(p) as SeriesPoint),
      projection: project(perViewer, budget),
      budgetBps: budget,
      agora,
    };
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

  private async take() {
    const now = this.clock.now();
    const rooms = await this.liveRooms(now);
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

    // The tick count is in Redis because the lock hands the job to whichever
    // replica gets there first; a per-process count would bill too few minutes.
    if ((await this.redis.incr('eg:ticks')) % TICKS_PER_MINUTE === 0) {
      await this.billAgoraMinute(rooms.map((r, i) => ({ ...r, viewers: counts[i] })));
    }
  }

  // Agora bills per participant per minute, and the house host is a
  // participant while it publishes (Task 12 sets house:on:<roomId>).
  private async billAgoraMinute(rooms: { id: string; kind: string; viewers: number }[]) {
    const video = rooms.filter((r) => r.kind === 'VIDEO');
    const hosts = await Promise.all(video.map((r) => this.redis.exists(`house:on:${r.id}`)));
    const total = video.reduce((sum, r, i) => sum + r.viewers + hosts[i], 0);
    if (total > 0) await this.minutes.add(total);
  }

  // The previous reading lives in Redis for the same reason as the tick count.
  // It expires, so a long gap between samples gives a gap in the line instead
  // of one flat average across it.
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
