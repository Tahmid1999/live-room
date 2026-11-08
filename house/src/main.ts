import { setTimeout as sleep } from 'node:timers/promises';
import { Browser, chromium, Page } from 'playwright';
import { Feed } from './feed';
import { SendProgress } from './progress';
import { decide, videoPaused } from './rule';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4110';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3130';
const HOUSE_KEY = process.env.HOUSE_KEY ?? '';
const VIDEO_FILE = process.env.VIDEO_FILE ?? '/media/house.y4m';
const AUDIO_FILE = process.env.AUDIO_FILE ?? '/media/house.wav';

const VIDEO_TICK_MS = 2000;
const AUDIO_TICK_MS = 5000;
// The API forgets a publishing host 30 s after its last message.
const BEAT_MS = 10_000;
// A failed start (bad token, SDK refused, Chromium would not launch), or a
// page that died, is not retried every tick: each try mints a token and
// launches a browser, and whatever killed the last page may still be there.
const RETRY_MS = 10_000;
const JOIN_TIMEOUT_MS = 30_000;

type RoomCard = { id: string; kind: 'VIDEO' | 'AUDIO'; title: string; house: boolean; viewers: number };

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
  private progress = new SendProgress(0);
  // Said once per host, so the first deploy shows whether the byte check
  // runs or the status line is all there is to go on.
  private checkLogged = false;

  private feed: Feed | null = null;

  // Only the video host draws the room, so only it takes the feed.
  constructor(
    private readonly label: string,
    private readonly withFeed = false,
  ) {}

  async start(roomId: string, title = '') {
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
      await page.addInitScript(`window.houseTitle = ${JSON.stringify(title)};`);
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
    this.progress = new SendProgress(Date.now());
    await this.tell('publishing');
    this.beat = setInterval(() => {
      this.beating = this.tell('publishing');
    }, BEAT_MS);
    log(`${this.label} house publishing`);
    if (this.withFeed) this.startFeed(this.page);
  }

  // A string expression, not the (fn, arg) form: tsx rewrites function bodies
  // in a way that breaks when Playwright serialises them, and a string has no
  // body to rewrite. JSON is valid JS, so the update goes in as a literal.
  private startFeed(page: Page) {
    this.feed = new Feed({
      apiUrl: API_URL,
      houseKey: HOUSE_KEY,
      onState: (state) => log(`${this.label} house feed ${state}`),
    });
    this.feed.start((update) => {
      page.evaluate(`window.houseFeed?.(${JSON.stringify(update)})`).catch(() => {});
    });
  }

  // The poll below sees everyone in the room, including those who were there
  // before the feed opened or left without saying so; the feed's own viewer
  // events only cover joins and leaves it saw.
  setViewers(count: number) {
    if (!this.feed || !this.roomId) return;
    this.feed.push({ type: 'viewers', roomId: this.roomId, count, t: Date.now() });
  }

  // Not alive when the page crashed, says it lost its connection, or has
  // stopped sending: a track that ended leaves the page claiming "publishing"
  // while nothing leaves the machine.
  async alive() {
    if (!this.page) return false;
    const probe = await this.page
      .evaluate(async () => {
        // A closed connection's count is frozen; left in, a reconnect would
        // look like no growth until the new one caught up with the old total.
        const pcs = (window.housePcs ?? []).filter((pc) => pc.connectionState !== 'closed');
        window.housePcs = pcs;
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
    if (!this.checkLogged) {
      this.checkLogged = true;
      log(
        probe.pcs > 0
          ? `${this.label} house byte check on (${probe.pcs} peer connection${probe.pcs === 1 ? '' : 's'})`
          : `${this.label} house byte check off: no peer connection seen, trusting the page status`,
      );
    }
    // No open connection means the page's SDK did not use the wrapped
    // constructor, or is between connections; better to trust the status line
    // than to restart forever.
    if (probe.pcs === 0) return true;
    return this.progress.moving(probe.bytes, Date.now());
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
    this.feed?.stop();
    this.feed = null;
    clearInterval(this.beat);
    // A clean leave first: closing the browser would leave the seat in the
    // channel until the server times it out.
    await Promise.race([page.evaluate(() => window.houseStop?.()), sleep(3000)]).catch(() => {});
    await browser.close().catch(() => {});
    // A beat still in flight would land after 'stopped' and set the API's
    // house-on key again. The key only tells the API a transition from a
    // repeat, so a start within the next 30 s would not get its hood line.
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
        retryAt = Date.now() + RETRY_MS;
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
        retryAt = Date.now() + RETRY_MS;
      }
      const [{ video }, bandwidth] = await Promise.all([
        houseRooms(),
        api<{ transfer?: { paused?: boolean } }>('/bandwidth'),
      ]);
      // Failing closed is in videoPaused; this says so once, under a key the
      // end of the tick does not clear, so a bad API is not repeated every 2 s.
      if (bandwidth.transfer?.paused === undefined) {
        warn('bandwidth', new Error('/bandwidth has no transfer field; treating video as paused'));
      } else {
        lastWarning.delete('bandwidth');
      }
      const now = Date.now();
      const viewers = video?.viewers ?? 0;
      // Counted here, not by the API: it only knows who is present right now.
      emptySince = viewers > 0 ? null : (emptySince ?? now);
      const verdict = decide({
        running: host.running,
        viewers,
        emptySince,
        paused: videoPaused(bandwidth),
        now,
      });
      if (verdict === 'start' && video && now >= retryAt) {
        log('video house starting');
        await host.start(video.id, video.title);
      } else if (verdict === 'stop') {
        await host.stop();
      }
      host.setViewers(viewers);
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
  const video = new Host('video', true);
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
