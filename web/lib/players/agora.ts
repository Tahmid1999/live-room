import AgoraRTC, { IAgoraRTCClient } from 'agora-rtc-sdk-ng';
import type { JoinInfo } from '../api';
import type { Player } from './player';

export class AgoraPlayer implements Player {
  private client: IAgoraRTCClient | null = null;

  constructor(private readonly onLive: () => void) {}

  async start(el: HTMLElement, info: JoinInfo) {
    if (info.engine !== 'agora') throw new Error('not an Agora join');
    AgoraRTC.setLogLevel(3);
    const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
    this.client = client;
    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      if (mediaType === 'video') user.videoTrack?.play(el);
      else user.audioTrack?.play();
      this.onLive();
    });
    await client.setClientRole('audience', { level: 1 });
    await client.join(info.appId, info.channel, info.token, info.uid);
  }

  async stop() {
    const client = this.client;
    this.client = null;
    await client?.leave();
  }

  bitrate() {
    if (!this.client) return 0;
    const sum = (stats: Record<string, { receiveBitrate: number }>) =>
      Object.values(stats).reduce((n, s) => n + (s.receiveBitrate || 0), 0);
    return sum(this.client.getRemoteVideoStats()) + sum(this.client.getRemoteAudioStats());
  }
}
