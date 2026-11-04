import { DisconnectReason, RemoteTrack, RemoteTrackPublication, Room, RoomEvent } from 'livekit-client';
import { ApiError, renewRoom, type JoinInfo } from '../api';
import type { PlayerEvents } from './player';

const SAMPLE_MS = 2000;
// The server drops a seat 15 minutes after its last join or renew, and the
// first renew has to land well before that.
const RENEW_MS = 10 * 60_000;

export class LiveKitPlayer {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
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
      el.appendChild(track.attach());
      this.events.onLive(true);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, gone) => {
      track.detach();
      if (!this.othersSubscribed(room, gone)) this.events.onLive(false);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.room !== room) return;
      this.halt();
      this.events.onLive(false);
      // The seat sweep removes a viewer whose join proof lapsed. Connecting
      // again would only be removed again, so it is a reopen, not a lost line.
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        this.events.onReopen('still watching? reopen the room');
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
    this.renewTimer = setInterval(() => void this.renew(room, info.room), RENEW_MS);
  }

  async stop() {
    this.halt();
    document.removeEventListener('pointerdown', this.unlock);
    const room = this.room;
    this.room = null;
    this.events.onLive(false);
    // Leaving a connection that is already gone is not worth an error.
    await room?.disconnect().catch(() => {});
  }

  bitrate() {
    return this.bps;
  }

  private halt() {
    clearInterval(this.timer);
    clearInterval(this.renewTimer);
  }

  // The connection stays up without a fresh token; what the renew keeps alive
  // is the server's record that this guest joined.
  private async renew(room: Room, roomId: string) {
    try {
      await renewRoom(roomId);
      if (this.room === room && this.renewFailed) {
        this.renewFailed = false;
        this.events.onProblem('');
      }
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
