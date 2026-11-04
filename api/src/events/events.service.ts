import {
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { Clock, CLOCK } from '../clock';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';
import { REPLICA } from '../replica';

export type HoodEvent = {
  t: number;
  kind:
    | 'gift'
    | 'gift-dup'
    | 'gift-rejected'
    | 'join'
    | 'join-refused'
    | 'house'
    | 'settlement'
    | 'retention'
    | 'kill'
    | 'rate-limit';
  replica: string;
  text: string;
};

const KEEP = 200;
const HEARTBEAT_MS = 15_000;
// A refusal can be provoked by anyone in a loop; without this the same line
// would push every real event out of the 200 kept and cost a publish and an
// SSE write per attempt.
const THROTTLED: HoodEvent['kind'][] = ['rate-limit', 'join-refused', 'gift-rejected', 'gift-dup'];
const THROTTLE_MS = 1000;
// Each stream holds a connection and a subscriber for as long as it is open.
export const MAX_STREAMS = 100;

// Everything here is shown to anonymous visitors, so callers pass finished
// text and never a guest id, address, cookie or full tap id.
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger(EventsService.name);
  private readonly sub: Redis;
  private readonly live = new Subject<string>();
  // Bounded: keys are the few fixed refusal texts, tap label removed.
  private readonly lastSent = new Map<string, { at: number; skipped: number }>();
  // pub/sub channels ignore the db number, so a test run on db 1 would
  // otherwise hear a dev server on db 0 (same reason as the socket adapter key).
  private readonly channel: string;
  private readonly list: string;
  private open = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPLICA) private readonly replica: string,
    private readonly inflight: Inflight,
    config: ConfigService,
  ) {
    const base = config.get('NODE_ENV') === 'test' ? 'hood-test' : 'hood';
    this.channel = base;
    this.list = `${base}:last`;
    // A subscribed connection cannot run ordinary commands, so it gets its own.
    this.sub = redis.duplicate();
  }

  async onModuleInit() {
    this.sub.on('message', (_channel, raw) => this.live.next(raw));
    await this.sub.subscribe(this.channel);
  }

  // Not onApplicationShutdown: Nest closes the HTTP server after the destroy
  // hooks and waits for open connections, and an SSE stream never ends on its own.
  onModuleDestroy() {
    this.live.complete();
  }

  async onApplicationShutdown() {
    await this.sub.quit();
  }

  // Fire and forget: a failed publish must never fail the gift or the join
  // that produced it. Tracked, because shutdown has to let it finish before
  // the shared connection quits.
  emit(e: HoodEvent): void {
    const sent = this.throttled(e);
    if (!sent) return;
    const raw = JSON.stringify(sent);
    const work = this.redis
      .multi()
      .lpush(this.list, raw)
      .ltrim(this.list, 0, KEEP - 1)
      .publish(this.channel, raw)
      .exec()
      .catch((err) => this.log.warn(`event dropped: ${err.message}`));
    this.inflight.track(work);
  }

  // The replica name always ends the line, so call sites only write the part
  // that differs.
  note(kind: HoodEvent['kind'], text: string): void {
    this.emit({ t: this.clock.now(), kind, replica: this.replica, text: `${text} · ${this.replica}` });
  }

  async recent(): Promise<HoodEvent[]> {
    return (await this.rawRecent()).map((raw) => JSON.parse(raw));
  }

  // The backlog first, then whatever arrives. Live events are held while the
  // backlog is being read; one that is already in the backlog is dropped, so
  // an event published during the read is neither lost nor shown twice.
  get openStreams() {
    return this.open;
  }

  stream(): Observable<MessageEvent> {
    return new Observable((out) => {
      this.open++;
      // Also commits the response headers: Nest holds them back until the
      // first message, and an idle proxy cuts a stream that stays silent.
      out.next({ comment: 'keep-alive' });
      const beat = setInterval(() => out.next({ comment: 'keep-alive' }), HEARTBEAT_MS);
      let backlogSent = false;
      const held: string[] = [];
      const listening = this.live.subscribe({
        next: (raw) => (backlogSent ? out.next({ data: raw }) : held.push(raw)),
        complete: () => out.complete(),
      });
      this.rawRecent().then(
        (backlog) => {
          const seen = new Set(backlog);
          for (const raw of backlog) out.next({ data: raw });
          for (const raw of held) if (!seen.has(raw)) out.next({ data: raw });
          backlogSent = true;
        },
        (err) => out.error(err),
      );
      return () => {
        this.open--;
        clearInterval(beat);
        listening.unsubscribe();
      };
    });
  }

  // Returns the event to send, or undefined to drop it. The first of a burst
  // goes out at once; the next one let through says how many it stands for.
  private throttled(e: HoodEvent): HoodEvent | undefined {
    if (!THROTTLED.includes(e.kind)) return e;
    // The tap label is the only part a client can vary; keyed on it, a loop of
    // fresh tap ids would never be throttled and the map would grow without bound.
    const key = `${e.kind}:${e.text.replace(/ tap-[0-9a-f]{4}/, '')}`;
    const now = this.clock.now();
    const prev = this.lastSent.get(key);
    if (prev && now - prev.at < THROTTLE_MS) {
      prev.skipped++;
      return undefined;
    }
    this.lastSent.set(key, { at: now, skipped: 0 });
    return prev?.skipped ? { ...e, text: `${e.text} · x${prev.skipped + 1}` } : e;
  }

  private async rawRecent() {
    // LPUSH keeps the newest first; readers want reading order.
    return (await this.redis.lrange(this.list, 0, KEEP - 1)).reverse();
  }
}
