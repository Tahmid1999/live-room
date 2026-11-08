import { DisconnectReason, RemoteTrack, RemoteTrackPublication, Room, RoomEvent } from 'livekit-client';
import { SAMPLE_SLOW_MS } from '../clock';
import { readStamp } from '../stamp';
import { ApiError, renewRoom, type JoinInfo } from '../api';
import type { PlayerEvents } from './player';

const SAMPLE_MS = 2000;
// The strip survives a copy a quarter of the canvas on each side (see stamp.ts).
const STAMP_W = 160;
const STAMP_H = 90;
// The server drops a seat 15 minutes after its last join or renew, and the
// first renew has to land well before that.
const RENEW_MS = 10 * 60_000;
// A failed renew cannot wait the full ten minutes for its next try: that is
// past the 15 the server allows, so one network blip would cost the seat.
const RETRY_MS = 30_000;

export class LiveKitPlayer {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private stampTimer: ReturnType<typeof setInterval> | undefined;
  private stampMs = SAMPLE_SLOW_MS;
  private stampCtx: CanvasRenderingContext2D | null = null;
  private elements = new Map<RemoteTrack, HTMLMediaElement>();
  private renewFailed = false;
  private bps = 0;
  private measuring = false;
  private seen = new Map<string, { bytes: number; at: number }>();
  private unlock = () => {};

  constructor(private readonly events: PlayerEvents) {}

  async start(el: HTMLElement, info: JoinInfo) {
    const what = info.kind === 'VIDEO' ? 'video' : 'audio';
    const room = new Room({ adaptiveStream: true });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      const media = track.attach();
      this.elements.set(track, media);
      el.appendChild(media);
      this.events.onLive(true);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, gone) => {
      // By the time this event fires the track has already let go of its
      // elements (detach() returns none), so the page would keep a blank one
      // over the next stream unless we remove what we put there.
      track.detach();
      this.elements.get(track)?.remove();
      this.elements.delete(track);
      if (!this.othersSubscribed(room, gone)) this.events.onLive(false);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.room !== room) return;
      // Let go of the room so a renew still in flight sees it is dead and does
      // not schedule another.
      this.room = null;
      this.halt();
      this.clearMount();
      this.events.onLive(false);
      // The seat sweep removes a viewer whose join proof lapsed, and every
      // guest while video is paused. Connecting again would only be removed
      // again, so it is a reopen, not a lost line; the join says the reason.
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        this.events.onReopen('the server closed your seat · reopen the room');
      } else {
        this.events.onProblem(`${what} connection lost`);
      }
    });
    await room.connect(info.url, info.token);
    // A page opened by a reload has had no tap yet, and the browser keeps
    // audio muted until one; the first tap anywhere unlocks it.
    this.unlock = () => void room.startAudio();
    document.addEventListener('pointerdown', this.unlock, { once: true });
    this.timer = setInterval(() => void this.measure(), SAMPLE_MS);
    // Only video seats are swept, so only video needs the server's record of
    // the join kept fresh; an audio listener's stats do that already.
    if (info.kind === 'VIDEO') {
      this.scheduleRenew(room, info.room, RENEW_MS);
      this.stampTimer = setInterval(() => this.sampleStamp(), this.stampMs);
    }
  }

  async stop() {
    this.halt();
    this.clearMount();
    document.removeEventListener('pointerdown', this.unlock);
    const room = this.room;
    this.room = null;
    this.events.onLive(false);
    // Leaving a connection that is already gone is not worth an error.
    await room?.disconnect().catch(() => {});
  }

  // Faster while the room waits for a gift's code to come back in the picture.
  setStampRate(ms: number) {
    if (ms === this.stampMs) return;
    this.stampMs = ms;
    if (this.stampTimer === undefined) return;
    clearInterval(this.stampTimer);
    this.stampTimer = setInterval(() => this.sampleStamp(), ms);
  }

  bitrate() {
    return this.bps;
  }

  // The mount outlives this player (a reopen starts a new one in the same div),
  // so take out only what this one put there.
  private clearMount() {
    for (const media of this.elements.values()) media.remove();
    this.elements.clear();
  }

  private halt() {
    clearInterval(this.timer);
    clearInterval(this.stampTimer);
    // Left set, a later setStampRate would start a timer on a stopped player.
    this.stampTimer = undefined;
    clearTimeout(this.renewTimer);
  }

  // The connection stays up without a fresh token; what the renew keeps alive
  // is the server's record that this guest joined.
  private scheduleRenew(room: Room, roomId: string, ms: number) {
    this.renewTimer = setTimeout(() => void this.renew(room, roomId), ms);
  }

  private async renew(room: Room, roomId: string) {
    try {
      await renewRoom(roomId);
      if (this.room !== room) return;
      if (this.renewFailed) {
        this.renewFailed = false;
        this.events.onProblem('');
      }
      this.scheduleRenew(room, roomId, RENEW_MS);
    } catch (err) {
      if (this.room !== room) return;
      // 403: the renewals for the day are used up. 503: video is paused for the
      // month. Asking again will not help in either case; joining will say why.
      if (err instanceof ApiError && (err.status === 403 || err.status === 503)) {
        this.events.onReopen(err.message);
        return;
      }
      this.renewFailed = true;
      this.events.onProblem(`could not renew the seat · ${(err as Error).message}`);
      this.scheduleRenew(room, roomId, RETRY_MS);
    }
  }

  // Reads the strip from the frame on screen. Nothing here may throw into the
  // room: a copy that cannot be made (a tainted or not yet decoded frame) is
  // just a second without a stamp.
  private sampleStamp() {
    if (document.visibilityState !== 'visible') return;
    const video = [...this.elements.values()].find((m): m is HTMLVideoElement => m instanceof HTMLVideoElement);
    if (!video || video.paused || video.ended || video.readyState < 2) return;
    try {
      if (!this.stampCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = STAMP_W;
        canvas.height = STAMP_H;
        this.stampCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      const ctx = this.stampCtx;
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, STAMP_W, STAMP_H);
      const stamp = readStamp(ctx.getImageData(0, 0, STAMP_W, STAMP_H).data, STAMP_W, STAMP_H);
      if (stamp) this.events.onStamp(stamp);
    } catch {
      // see above
    }
  }

  // The event fires before the publication lets go of its track, so the one
  // that just went still reports subscribed and has to be left out.
  private othersSubscribed(room: Room, gone: RemoteTrackPublication) {
    return [...room.remoteParticipants.values()].some((p) =>
      [...p.trackPublications.values()].some((pub) => pub !== gone && pub.isSubscribed),
    );
  }

  // inbound-rtp only has a running byte total, so the rate is the change since
  // the last look divided by the time the browser stamped between the two
  // reports, not by the timer, which drifts when a report is slow.
  private async measure() {
    const room = this.room;
    // A slow stats call must not overlap the next tick and read the same
    // baseline twice.
    if (!room || this.measuring) return;
    this.measuring = true;
    try {
      let bps = 0;
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          const track = pub.track as RemoteTrack | undefined;
          if (!track) continue;
          const report = await track.getRTCStatsReport();
          report?.forEach((stat) => {
            if (stat.type !== 'inbound-rtp') return;
            const before = this.seen.get(stat.id);
            this.seen.set(stat.id, { bytes: stat.bytesReceived, at: stat.timestamp });
            if (before && stat.timestamp > before.at) {
              bps += Math.max(((stat.bytesReceived - before.bytes) * 8000) / (stat.timestamp - before.at), 0);
            }
          });
        }
      }
      this.bps = Math.round(bps);
    } finally {
      this.measuring = false;
    }
  }
}
