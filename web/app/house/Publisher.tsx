'use client';

import { useEffect, useState } from 'react';
import type { LocalTrack } from 'livekit-client';
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
  const info = window.houseJoin as Partial<JoinInfo> | undefined;
  const ok =
    typeof info?.url === 'string' &&
    typeof info.token === 'string' &&
    (info.kind === 'VIDEO' || info.kind === 'AUDIO');
  return ok ? (info as JoinInfo) : null;
}

// Echo cancellation and noise suppression are built for speech and would
// flatten a generated tone to silence.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

async function publish(info: JoinInfo, set: (s: State) => void) {
  const { Room, RoomEvent, createLocalAudioTrack, createLocalVideoTrack } = await import('livekit-client');
  const room = new Room();
  room.on(RoomEvent.Disconnected, () => set('error'));
  await room.connect(info.url, info.token);
  const mic = await createLocalAudioTrack(RAW_AUDIO);
  await room.localParticipant.publishTrack(mic);
  const tracks: LocalTrack[] = [mic];
  if (info.kind === 'VIDEO') {
    const cam = await createLocalVideoTrack({ resolution: { width: 640, height: 360, frameRate: 15 } });
    // One layer at a fixed bitrate: a simulcast ladder would send the node
    // three copies of a 360p picture it serves to 20 phones at most.
    await room.localParticipant.publishTrack(cam, {
      simulcast: false,
      videoEncoding: { maxBitrate: 800_000, maxFramerate: 15 },
    });
    tracks.push(cam);
  }
  set('publishing');
  return async () => {
    tracks.forEach((t) => t.stop());
    await room.disconnect();
  };
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
    const start = publish(info, set);
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
