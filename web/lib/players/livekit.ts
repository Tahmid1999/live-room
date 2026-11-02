import { RemoteTrack, Room, RoomEvent } from 'livekit-client';
import type { JoinInfo } from '../api';
import type { Player } from './player';

const SAMPLE_MS = 2000;

export class LiveKitPlayer implements Player {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private bps = 0;
  private seen = new Map<string, number>();

  constructor(private readonly onLive: () => void) {}

  async start(el: HTMLElement, info: JoinInfo) {
    if (info.engine !== 'livekit') throw new Error('not a LiveKit join');
    const room = new Room({ adaptiveStream: true });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      el.appendChild(track.attach());
      this.onLive();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
    await room.connect(info.url, info.token);
    // A page opened by a reload has had no tap yet, and the browser keeps
    // audio muted until one; the first tap anywhere unlocks it.
    document.addEventListener('pointerdown', () => void room.startAudio(), { once: true });
    this.timer = setInterval(() => void this.measure(), SAMPLE_MS);
  }

  async stop() {
    clearInterval(this.timer);
    const room = this.room;
    this.room = null;
    await room?.disconnect();
  }

  bitrate() {
    return this.bps;
  }

  // inbound-rtp only has a running byte total, so the rate is the change since
  // the last look, per track so a track that comes or goes does not skew it.
  private async measure() {
    const room = this.room;
    if (!room) return;
    let bytes = 0;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const track = pub.track as RemoteTrack | undefined;
        if (!track) continue;
        const report = await track.getRTCStatsReport();
        report?.forEach((stat) => {
          if (stat.type !== 'inbound-rtp') return;
          const before = this.seen.get(stat.id) ?? stat.bytesReceived;
          bytes += Math.max(stat.bytesReceived - before, 0);
          this.seen.set(stat.id, stat.bytesReceived);
        });
      }
    }
    this.bps = Math.round((bytes * 8) / (SAMPLE_MS / 1000));
  }
}
