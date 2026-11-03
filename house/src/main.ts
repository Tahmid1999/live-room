import { setTimeout as sleep } from 'node:timers/promises';
import { Browser, chromium, Page } from 'playwright';
import { decide } from './rule';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4110';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3130';
const HOUSE_KEY = process.env.HOUSE_KEY ?? '';
const VIDEO_FILE = process.env.VIDEO_FILE ?? '/media/house.y4m';
const AUDIO_FILE = process.env.AUDIO_FILE ?? '/media/house.wav';

const VIDEO_TICK_MS = 2000;
const AUDIO_TICK_MS = 5000;
// The API forgets a publishing host 30 s after its last message.
const BEAT_MS = 10_000;
// A failed start (bad token, SDK refused, Chromium would not launch) is not
// retried every tick: each try mints a token and launches a browser.
const RETRY_MS = 10_000;
const JOIN_TIMEOUT_MS = 30_000;
// Opus goes quiet in silence but never stops sending, and video never does,
// so ten seconds without a single new byte means the publisher is stuck.
const STALL_MS = 10_000;

type RoomCard = { id: string; kind: 'VIDEO' | 'AUDIO'; house: boolean; viewers: number };

const closing = new AbortController();

const stamp = () => new Date().toISOString();
const log = (text: string) => console.log(`${stamp()} ${text}`);

// The same failure repeating every tick (API down) is said once; a success
// clears it, so the next outage is said again.
const lastWarning = new Map<string, string>();
function warn(who: string, err: unknown) {
  // Defence in depth: no URL fragment may reach the log, whatever threw.
  const text = (err instanceof Error ? err.message : String(err)).replace(/#\S+/g, '#[hidden]');
  if (lastWarning.get(who) === text) return;
  lastWarning.set(who, text);
  log(`${who}: ${text}`);
}

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-house-key': HOUSE_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

const chromiumArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${VIDEO_FILE}`,
  `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
];

// Collects every RTCPeerConnection the page makes, so the worker can see
// whether bytes are still leaving it. A string, not a function: tsx rewrites
// function bodies in a way that breaks when Playwright serialises them.
const TRACK_PEER_CONNECTIONS = `(() => {
  const Native = window.RTCPeerConnection;
  window.housePcs = [];
  window.RTCPeerConnection = new Proxy(Native, {
    construct(target, args) {
      const pc = new target(...args);
      window.housePcs.push(pc);
      return pc;
    },
  });
})()`;

class Host {
  private browser: Browser | null = null;
  private page: Page | null = null;
  // Held from launch until the page is publishing, so a shutdown can cut a start short.
  private launching: Browser | null = null;
  private roomId = '';
  private beat: NodeJS.Timeout | undefined;
  private beating: Promise<void> = Promise.resolve();
  private sentBytes = 0;
  private grewAt = 0;

  constructor(private readonly label: string) {}

  async start(roomId: string) {
    const info = await api('/house/token', { roomId });
    const browser = await chromium.launch({ args: chromiumArgs });
    this.launching = browser;
    try {
      if (closing.signal.aborted) throw new Error('shutting down');
      const page = await browser.newPage();
      // The token is handed to the page by script and never put in a URL:
      // navigation errors quote the URL, and those end up in the logs.
      await page.addInitScript(TRACK_PEER_CONNECTIONS);
      await page.addInitScript(`window.houseJoin = ${JSON.stringify(info)};`);
      await page.goto(`${WEB_URL}/house`);
      await page.waitForSelector('[data-state="publishing"]', { timeout: JOIN_TIMEOUT_MS });
      this.browser = browser;
      this.page = page;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    } finally {
      this.launching = null;
    }
    this.roomId = roomId;
    this.sentBytes = 0;
    this.grewAt = Date.now();
    await this.tell('publishing');
    this.beat = setInterval(() => {
      this.beating = this.tell('publishing');
    }, BEAT_MS);
    log(`${this.label} house publishing`);
  }

  // Not alive when the page crashed, says it lost its connection, or has
  // stopped sending: a track that ended leaves the page claiming "publishing"
  // while nothing leaves the machine.
  async alive() {
    if (!this.page) return false;
    const probe = await this.page
      .evaluate(async () => {
        const pcs: RTCPeerConnection[] = window.housePcs ?? [];
        let bytes = 0;
        for (const pc of pcs) {
          (await pc.getStats()).forEach((s) => {
            if (s.type === 'outbound-rtp') bytes += s.bytesSent;
          });
        }
        const state = document.querySelector('[data-state]')?.getAttribute('data-state');
        return { state, pcs: pcs.length, bytes };
      })
      .catch(() => null);
    if (probe?.state !== 'publishing') return false;
    // No connection seen at all means the page's SDK did not use the wrapped
    // constructor; better to trust the status line than to restart forever.
    if (probe.pcs === 0) return true;
    const now = Date.now();
    if (probe.bytes > this.sentBytes) {
      this.sentBytes = probe.bytes;
      this.grewAt = now;
    }
    return now - this.grewAt < STALL_MS;
  }

  get running() {
    return this.page !== null;
  }

  // Cuts a start that is still joining; the start then fails and its caller moves on.
  async abort() {
    await this.launching?.close().catch(() => {});
  }

  async stop() {
    const { browser, page, roomId } = this;
    if (!browser || !page) return;
    this.browser = this.page = null;
    clearInterval(this.beat);
    // A clean leave first: closing the browser would leave the seat in the
    // channel until the server times it out.
    await Promise.race([page.evaluate(() => window.houseStop?.()), sleep(3000)]).catch(() => {});
    await browser.close().catch(() => {});
    // A beat still in flight would land after 'stopped' and mark the house
    // on for another 30 s, which Agora minute billing counts.
    await this.beating;
    await this.tell('stopped', roomId);
    log(`${this.label} house stopped`);
  }

  private async tell(state: 'publishing' | 'stopped', roomId = this.roomId) {
    await api('/house/event', { roomId, state }).then(
      () => lastWarning.delete(`${this.label} event`),
      (err) => warn(`${this.label} event`, err),
    );
  }
}

declare global {
  interface Window {
    houseStop?: () => Promise<void>;
    housePcs?: RTCPeerConnection[];
  }
}

async function houseRooms() {
  const rooms = await api<RoomCard[]>('/rooms');
  return {
    video: rooms.find((r) => r.house && r.kind === 'VIDEO'),
    audio: rooms.find((r) => r.house && r.kind === 'AUDIO'),
  };
}

const pause = (ms: number) => sleep(ms, undefined, { signal: closing.signal }).catch(() => {});

// The audio room is never empty: it starts at boot and is put back whenever
// its page crashes or loses the connection (a six-hour token ends that way too).
async function superviseAudio(host: Host) {
  let retryAt = 0;
  while (!closing.signal.aborted) {
    try {
      if (host.running && !(await host.alive())) {
        log('audio house lost its page');
        await host.stop();
      }
      if (!host.running && Date.now() >= retryAt) {
        const { audio } = await houseRooms();
        if (audio) await host.start(audio.id);
      }
      if (Date.now() >= retryAt) lastWarning.delete('audio');
    } catch (err) {
      if (!closing.signal.aborted) warn('audio', err);
      retryAt = Date.now() + RETRY_MS;
    }
    await pause(AUDIO_TICK_MS);
  }
}

async function superviseVideo(host: Host) {
  let emptySince: number | null = null;
  let retryAt = 0;
  while (!closing.signal.aborted) {
    try {
      if (host.running && !(await host.alive())) {
        log('video house lost its page');
        await host.stop();
      }
      const [{ video }, bandwidth] = await Promise.all([
        houseRooms(),
        api<{ agora: { paused: boolean } }>('/bandwidth'),
      ]);
      const now = Date.now();
      const viewers = video?.viewers ?? 0;
      // Counted here, not by the API: it only knows who is present right now.
      emptySince = viewers > 0 ? null : (emptySince ?? now);
      const verdict = decide({
        running: host.running,
        viewers,
        emptySince,
        paused: bandwidth.agora.paused,
        now,
      });
      if (verdict === 'start' && video && now >= retryAt) {
        log('video house starting');
        await host.start(video.id);
      } else if (verdict === 'stop') {
        await host.stop();
      }
      if (Date.now() >= retryAt) lastWarning.delete('video');
    } catch (err) {
      if (!closing.signal.aborted) warn('video', err);
      retryAt = Date.now() + RETRY_MS;
    }
    await pause(VIDEO_TICK_MS);
  }
}

async function main() {
  if (!HOUSE_KEY) throw new Error('HOUSE_KEY is not set');
  const audio = new Host('audio');
  const video = new Host('video');
  const loops = Promise.all([superviseAudio(audio), superviseVideo(video)]);

  const shutdown = async () => {
    closing.abort();
    // A start still joining is cut short, so this finishes inside Docker's
    // 10 s grace instead of waiting out the 30 s join timeout.
    await Promise.all([audio.abort(), video.abort()]);
    await loops;
    await Promise.all([audio.stop(), video.stop()]);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  log(`house worker up, api ${API_URL}, web ${WEB_URL}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
