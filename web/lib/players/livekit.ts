import { RemoteTrack, Room, RoomEvent } from 'livekit-client';
import type { JoinInfo } from '../api';
import type { Player, PlayerEvents } from './player';

const SAMPLE_MS = 2000;

export class LiveKitPlayer implements Player {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private bps = 0;
  private measuring = false;
  private seen = new Map<string, { bytes: number; at: number }>();
  private unlock = () => {};

  constructor(private readonly events: PlayerEvents) {}

  async start(el: HTMLElement, info: JoinInfo) {
    if (info.engine !== 'livekit') throw new Error('not a LiveKit join');
    const room = new Room({ adaptiveStream: true });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      el.appendChild(track.attach());
      this.events.onLive(true);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      if (!this.subscribed(room)) this.events.onLive(false);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.events.onLive(false);
      this.events.onProblem('audio connection lost');
    });
    await room.connect(info.url, info.token);
    // A page opened by a reload has had no tap yet, and the browser keeps
    // audio muted until one; the first tap anywhere unlocks it.
    this.unlock = () => void room.startAudio();
    document.addEventListener('pointerdown', this.unlock, { once: true });
    this.timer = setInterval(() => void this.measure(), SAMPLE_MS);
  }

  async stop() {
    clearInterval(this.timer);
    document.removeEventListener('pointerdown', this.unlock);
    const room = this.room;
    this.room = null;
    this.events.onLive(false);
    await room?.disconnect();
  }

  bitrate() {
    return this.bps;
  }

  private subscribed(room: Room) {
    return [...room.remoteParticipants.values()].some((p) =>
      [...p.trackPublications.values()].some((pub) => pub.isSubscribed),
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
