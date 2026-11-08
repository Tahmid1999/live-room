// What the video house page draws comes from two places: the API's private
// event feed (gifts, joins, viewer counts) and the public /bandwidth numbers.
// This file reads both and hands the page one stream of updates.

export type FeedUpdate =
  | { type: 'gift'; roomId: string; name: string; giftId: string; coins: number; replica: string; tap: string; t: number }
  | { type: 'join'; roomId: string; name: string; t: number }
  | { type: 'viewers'; roomId: string; count: number; t: number }
  | { type: 'bandwidth'; bps: number; usedBytes: number; budgetBytes: number };

const RECONNECT_MS = 3000;
const BANDWIDTH_MS = 5000;
const BANDWIDTH_TIMEOUT_MS = 5000;
// The API publishes a viewer count on every join and leave; the page only
// needs the latest one a couple of times a second.
export const VIEWERS_FLUSH_MS = 500;

// Splits a chunk of an event stream into events. A chunk can end mid-event, so
// the unfinished tail comes back as `carry` and goes in front of the next chunk.
// Comment lines (heartbeats) and data that is not JSON are dropped.
export function parseSse(chunk: string, carry: string): { events: unknown[]; carry: string } {
  const parts = (carry + chunk).replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const events: unknown[] = [];
  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A half-written or foreign line must not end the stream.
    }
  }
  return { events, carry: rest };
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// bps is the last series point's LiveKit rate. A point the API could not
// measure (null) or an empty series reads as 0: the meter then shows an idle
// node instead of vanishing.
export function toBandwidthUpdate(body: unknown): FeedUpdate | null {
  if (typeof body !== 'object' || body === null) return null;
  const { series, transfer } = body as { series?: unknown; transfer?: { usedBytes?: unknown; budgetBytes?: unknown } };
  if (!Array.isArray(series)) return null;
  if (!transfer || !isNumber(transfer.usedBytes) || !isNumber(transfer.budgetBytes)) return null;
  const last = series[series.length - 1] as { livekitBps?: unknown } | undefined;
  const bps = isNumber(last?.livekitBps) ? last.livekitBps : 0;
  return { type: 'bandwidth', bps, usedBytes: transfer.usedBytes, budgetBytes: transfer.budgetBytes };
}

// Everything but viewer counts passes straight through. Counts are held, one
// per room, and sent together once the window ends.
export class Coalescer {
  private pending = new Map<string, FeedUpdate>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly emit: (update: FeedUpdate) => void,
    private readonly windowMs = VIEWERS_FLUSH_MS,
  ) {}

  push(update: FeedUpdate) {
    if (update.type !== 'viewers') return this.emit(update);
    this.pending.set(update.roomId, update);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const batch = [...this.pending.values()];
      this.pending.clear();
      batch.forEach(this.emit);
    }, this.windowMs);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}

// The signal lives as long as the host, so the listener is removed when the
// timer wins; otherwise one would pile up per poll.
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

const isUpdate = (e: unknown): e is FeedUpdate => {
  const type = (e as { type?: unknown } | null)?.type;
  return type === 'gift' || type === 'join' || type === 'viewers';
};

export type FeedOptions = {
  apiUrl: string;
  houseKey: string;
  // Called on a change of connection state only, never with feed content.
  onState: (state: 'connected' | 'lost') => void;
  // Overridable so tests need not wait out the real delays.
  reconnectMs?: number;
  bandwidthMs?: number;
};

export class Feed {
  private abort: AbortController | null = null;
  private coalescer: Coalescer | null = null;

  constructor(private readonly options: FeedOptions) {}

  start(onUpdate: (update: FeedUpdate) => void) {
    if (this.abort) return;
    const abort = (this.abort = new AbortController());
    const coalescer = (this.coalescer = new Coalescer(onUpdate));
    abort.signal.addEventListener('abort', () => coalescer.stop());
    void this.readLoop(abort.signal, (u) => coalescer.push(u));
    void this.bandwidthLoop(abort.signal, onUpdate);
  }

  // For updates that do not come from the stream, such as the worker's own
  // viewer count; they take the same coalescing path as the stream's.
  push(update: FeedUpdate) {
    this.coalescer?.push(update);
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    this.coalescer = null;
  }

  private async readLoop(signal: AbortSignal, push: (update: FeedUpdate) => void) {
    let connected = false;
    const setState = (now: boolean) => {
      if (now === connected || signal.aborted) return;
      connected = now;
      this.options.onState(now ? 'connected' : 'lost');
    };
    while (!signal.aborted) {
      try {
        // No timeout here: the stream is meant to stay open. A silent drop
        // surfaces as the read ending or failing.
        const res = await fetch(`${this.options.apiUrl}/house/feed`, {
          headers: { 'x-house-key': this.options.houseKey, accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`feed answered ${res.status}`);
        setState(true);
        const decoder = new TextDecoder();
        let carry = '';
        for await (const chunk of res.body) {
          const parsed = parseSse(decoder.decode(chunk, { stream: true }), carry);
          carry = parsed.carry;
          parsed.events.filter(isUpdate).forEach(push);
        }
      } catch {
        // Reported as a state change below; the error text can carry the URL.
      }
      setState(false);
      await wait(this.options.reconnectMs ?? RECONNECT_MS, signal);
    }
  }

  private async bandwidthLoop(signal: AbortSignal, onUpdate: (update: FeedUpdate) => void) {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.options.apiUrl}/bandwidth`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(BANDWIDTH_TIMEOUT_MS)]),
        });
        const update = res.ok ? toBandwidthUpdate(await res.json()) : null;
        if (update && !signal.aborted) onUpdate(update);
      } catch {
        // The meter keeps its last numbers; the next poll tries again.
      }
      await wait(this.options.bandwidthMs ?? BANDWIDTH_MS, signal);
    }
  }
}
