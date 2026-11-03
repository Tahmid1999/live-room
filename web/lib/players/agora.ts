import AgoraRTC, { IAgoraRTCClient } from 'agora-rtc-sdk-ng';
import { ApiError, renewRoom, type JoinInfo } from '../api';
import type { Player, PlayerEvents } from './player';

export class AgoraPlayer implements Player {
  private client: IAgoraRTCClient | null = null;

  constructor(private readonly events: PlayerEvents) {}

  async start(el: HTMLElement, info: JoinInfo) {
    if (info.engine !== 'agora') throw new Error('not an Agora join');
    AgoraRTC.setLogLevel(3);
    const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
    this.client = client;
    // Events that arrive after stop() describe a client we already let go.
    const current = () => this.client === client;

    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      if (!current()) return;
      if (mediaType === 'video') user.videoTrack?.play(el);
      else user.audioTrack?.play();
      this.events.onLive(true);
    });
    client.on('user-unpublished', (_user, mediaType) => {
      if (current() && mediaType === 'video') this.events.onLive(false);
    });
    // Viewer tokens last ten minutes, so a stream that outlives one has to ask
    // for another before the server drops the connection.
    client.on('token-privilege-will-expire', async () => {
      try {
        const next = await renewRoom(info.channel);
        if (next.engine === 'agora' && current()) await client.renewToken(next.token);
      } catch (err) {
        if (!current()) return;
        // An hour of video a day without a fresh join, or a seat the server
        // has forgotten: either way asking again will not help, joining will.
        if (err instanceof ApiError && err.status === 403) this.events.onReopen(err.message);
        else this.events.onProblem(`could not renew the video token · ${(err as Error).message}`);
      }
    });
    client.on('token-privilege-did-expire', () => {
      if (!current()) return;
      this.events.onLive(false);
      this.events.onProblem('video stopped · the token expired');
    });
    client.on('connection-state-change', (state) => {
      if (!current()) return;
      if (state === 'DISCONNECTED') {
        this.events.onLive(false);
        this.events.onProblem('video connection lost');
      } else if (state === 'CONNECTED') {
        this.events.onProblem('');
      }
    });

    await client.setClientRole('audience', { level: 1 });
    await client.join(info.appId, info.channel, info.token, info.uid);
  }

  async stop() {
    const client = this.client;
    this.client = null;
    this.events.onLive(false);
    // Leaving a connection that is already gone is not worth an error.
    await client?.leave().catch(() => {});
  }

  bitrate() {
    if (!this.client) return 0;
    const sum = (stats: Record<string, { receiveBitrate: number }>) =>
      Object.values(stats).reduce((n, s) => n + (s.receiveBitrate || 0), 0);
    return sum(this.client.getRemoteVideoStats()) + sum(this.client.getRemoteAudioStats());
  }
}
