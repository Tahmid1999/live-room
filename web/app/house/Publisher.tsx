'use client';

import { useEffect, useState } from 'react';
import type { JoinInfo } from '@/lib/api';

type State = 'connecting' | 'publishing' | 'stopped' | 'refused' | 'error';

declare global {
  interface Window {
    // The worker calls this before closing the browser, so the server sees a
    // clean leave and does not keep billing the seat until its own timeout.
    houseStop?: () => Promise<void>;
    houseJoin?: unknown;
  }
}

// The worker puts the join info on window before any page script runs, so the
// token is never part of a URL: navigation errors and proxies quote URLs.
function readJoinInfo(): JoinInfo | null {
  const info = window.houseJoin as JoinInfo | undefined;
  return info?.engine === 'agora' || info?.engine === 'livekit' ? info : null;
}

// Echo cancellation and noise suppression are built for speech and would
// flatten a generated tone to silence.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

async function publishAgora(info: Extract<JoinInfo, { engine: 'agora' }>, set: (s: State) => void) {
  const { default: AgoraRTC } = await import('agora-rtc-sdk-ng');
  AgoraRTC.setLogLevel(3);
  const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
  client.on('connection-state-change', (state) => {
    if (state === 'DISCONNECTED') set('error');
  });
  client.on('token-privilege-did-expire', () => set('error'));
  await client.setClientRole('host');
  await client.join(info.appId, info.channel, info.token, info.uid);
  const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks(
    { AEC: false, ANS: false, AGC: false },
    { encoderConfig: { width: 640, height: 360, frameRate: 15, bitrateMin: 600, bitrateMax: 900 } },
  );
  await client.publish([mic, cam]);
  set('publishing');
  return async () => {
    mic.close();
    cam.close();
    await client.leave();
  };
}

async function publishLiveKit(info: Extract<JoinInfo, { engine: 'livekit' }>, set: (s: State) => void) {
  const { Room, RoomEvent, createLocalAudioTrack } = await import('livekit-client');
  const room = new Room();
  room.on(RoomEvent.Disconnected, () => set('error'));
  await room.connect(info.url, info.token);
  await room.localParticipant.publishTrack(await createLocalAudioTrack(RAW_AUDIO));
  set('publishing');
  return () => room.disconnect();
}

export function Publisher() {
  const [state, setState] = useState<State>('connecting');

  useEffect(() => {
    let leave: (() => Promise<void>) | undefined;
    let stopped = false;
    const set = (s: State) => !stopped && setState(s);

    const info = readJoinInfo();
    if (!info) {
      set('refused');
      return;
    }
    const start = info.engine === 'agora' ? publishAgora(info, set) : publishLiveKit(info, set);
    start.then(
      (fn) => {
        leave = fn;
        window.houseStop = async () => {
          stopped = true;
          setState('stopped');
          await leave?.().catch(() => {});
        };
      },
      () => set('error'),
    );
    return () => {
      stopped = true;
      void start.then((fn) => fn(), () => {});
    };
  }, []);

  return (
    <p data-state={state} style={{ margin: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
      house {state}
    </p>
  );
}
