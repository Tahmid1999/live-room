import {
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { Clock, CLOCK } from '../clock';
import { Inflight } from '../redis/inflight';
import { REDIS } from '../redis/redis.module';

// What the house page needs to draw the stream. Names are the app's generated
// guest names; no guest id, address, cookie or full tap id goes in here.
export type HouseFeedEvent =
  | { type: 'gift'; roomId: string; name: string; giftId: string; coins: number; replica: string; tap: string }
  | { type: 'join'; roomId: string; name: string }
  | { type: 'viewers'; roomId: string; count: number };

const HEARTBEAT_MS = 15_000;

// Private counterpart of EventsService: the public stream is finished text for
// anonymous visitors, this one is raw facts for the house worker.
@Injectable()
export class HouseFeed implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger(HouseFeed.name);
  private readonly sub: Redis;
  private readonly live = new Subject<string>();
  // pub/sub channels ignore the db number, so a test run on db 1 would
  // otherwise hear a dev server on db 0 (same reason as the events channel).
  private readonly channel: string;
  private open = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inflight: Inflight,
  ) {
    this.channel = `house:feed:${redis.options.db ?? 0}`;
    // A subscribed connection cannot run ordinary commands, so it gets its own.
    this.sub = redis.duplicate();
  }

  async onModuleInit() {
    this.sub.on('message', (_channel, raw) => this.live.next(raw));
    await this.sub.subscribe(this.channel);
  }

  // Not onApplicationShutdown: an SSE stream never ends on its own, and Nest
  // waits for open connections before running that hook.
  onModuleDestroy() {
    this.live.complete();
  }

  async onApplicationShutdown() {
    await this.sub.quit();
  }

  get openStreams() {
    return this.open;
  }

  // Fire and forget, and tracked so shutdown lets it finish: a pub/sub hiccup
  // must never fail the gift or the join that produced the event. The payload
  // carries guest names, so a failure logs the reason and nothing else.
  publish(event: HouseFeedEvent): void {
    const work = Promise.resolve()
      .then(() => this.redis.publish(this.channel, JSON.stringify({ ...event, t: this.clock.now() })))
      .catch((err) => this.log.warn(`house feed event dropped: ${err.message}`));
    this.inflight.track(work);
  }

  stream(): Observable<MessageEvent> {
    return new Observable((out) => {
      this.open++;
      // Also commits the response headers: Nest holds them back until the
      // first message, and an idle proxy cuts a stream that stays silent.
      out.next({ comment: 'keep-alive' });
      const beat = setInterval(() => out.next({ comment: 'keep-alive' }), HEARTBEAT_MS);
      const listening = this.live.subscribe({
        next: (raw) => out.next({ data: raw }),
        complete: () => out.complete(),
      });
      return () => {
        this.open--;
        clearInterval(beat);
        listening.unsubscribe();
      };
    });
  }
}
