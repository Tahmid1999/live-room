import { Global, Inject, Injectable, Module } from '@nestjs/common';

export const READ_CACHE_MS = Symbol('READ_CACHE_MS');

// The public reads are polled by every open page and cost several database
// and Redis calls each. Holding an answer for a second is invisible on pages
// that poll every 5 to 10 s, and caps what a loop of GETs can cost at one
// round per second per replica. Concurrent misses share one load.
@Injectable()
export class ReadCache {
  private readonly entries = new Map<string, { until: number; value: Promise<unknown> }>();

  constructor(@Inject(READ_CACHE_MS) private readonly ms: number) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const kept = this.entries.get(key);
    if (kept && kept.until > now) return kept.value as Promise<T>;
    const value = load();
    if (this.ms > 0) {
      const entry = { until: now + this.ms, value };
      this.entries.set(key, entry);
      // A failed load is not served to the next caller; it asks again.
      value.catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    }
    return value;
  }
}

@Global()
@Module({
  providers: [ReadCache, { provide: READ_CACHE_MS, useValue: 1000 }],
  exports: [ReadCache],
})
export class ReadCacheModule {}
