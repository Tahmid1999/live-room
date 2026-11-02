import {
  Inject,
  Injectable,
  Logger,
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
    | 'engine'
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

// Everything here is shown to anonymous visitors, so callers pass finished
// text and never a guest id, address, cookie or full tap id.
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger(EventsService.name);
  private readonly sub: Redis;
  private readonly live = new Subject<string>();
  // pub/sub channels ignore the db number, so a test run on db 1 would
  // otherwise hear a dev server on db 0 (same reason as the socket adapter key).
  private readonly channel: string;
  private readonly list: string;

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
    const raw = JSON.stringify(e);
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
  stream(): Observable<{ data: string }> {
    return new Observable((out) => {
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
      return () => listening.unsubscribe();
    });
  }

  private async rawRecent() {
    // LPUSH keeps the newest first; readers want reading order.
    return (await this.redis.lrange(this.list, 0, KEEP - 1)).reverse();
  }
}
