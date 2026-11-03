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

type RoomCard = { id: string; kind: 'VIDEO' | 'AUDIO'; house: boolean; viewers: number };

const stamp = () => new Date().toISOString();
const log = (text: string) => console.log(`${stamp()} ${text}`);

// The same failure repeating every tick (API down) is said once.
const lastWarning = new Map<string, string>();
function warn(who: string, err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
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

class Host {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private roomId = '';
  private beat: NodeJS.Timeout | undefined;

  constructor(private readonly label: string) {}

  async start(roomId: string) {
    // The token goes in the fragment: it stays out of request lines and access logs.
    const info = await api('/house/token', { roomId });
    const fragment = Buffer.from(JSON.stringify(info)).toString('base64url');
    const browser = await chromium.launch({ args: chromiumArgs });
    try {
      const page = await browser.newPage();
      await page.goto(`${WEB_URL}/house#${fragment}`);
      await page.waitForSelector('[data-state="publishing"]', { timeout: JOIN_TIMEOUT_MS });
      this.browser = browser;
      this.page = page;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
    this.roomId = roomId;
    await this.tell('publishing');
    this.beat = setInterval(() => void this.tell('publishing'), BEAT_MS);
    log(`${this.label} house publishing`);
  }

  // A crashed page throws on evaluate, a page that lost its connection says
  // so in its status line; either way the host is not publishing any more.
  async alive() {
    if (!this.page) return false;
    const state = await this.page
      .evaluate(() => document.querySelector('[data-state]')?.getAttribute('data-state'))
      .catch(() => 'crashed');
    return state === 'publishing';
  }

  get running() {
    return this.page !== null;
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
    await this.tell('stopped', roomId);
    log(`${this.label} house stopped`);
  }

  private async tell(state: 'publishing' | 'stopped', roomId = this.roomId) {
    await api('/house/event', { roomId, state }).catch((err) => warn(`${this.label} event`, err));
  }
}

declare global {
  interface Window {
    houseStop?: () => Promise<void>;
  }
}

async function houseRooms() {
  const rooms = await api<RoomCard[]>('/rooms');
  return {
    video: rooms.find((r) => r.house && r.kind === 'VIDEO'),
    audio: rooms.find((r) => r.house && r.kind === 'AUDIO'),
  };
}

const closing = new AbortController();
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
    } catch (err) {
      warn('audio', err);
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
    } catch (err) {
      warn('video', err);
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
    // A start that is mid-flight finishes first, so its browser is not orphaned.
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
