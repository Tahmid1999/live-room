'use client';

import { useEffect, useState } from 'react';
import type { LocalTrack } from 'livekit-client';
import type { JoinInfo } from '@/lib/api';
import { createScene, type FeedUpdate } from '@/lib/house-scene';
import { STAMP } from '@/lib/stamp';

type State = 'connecting' | 'publishing' | 'stopped' | 'refused' | 'error';

declare global {
  interface Window {
    // The worker calls this before closing the browser, so the server sees a
    // clean leave and does not keep billing the seat until its own timeout.
    houseStop?: () => Promise<void>;
    houseJoin?: unknown;
    // The worker forwards the API's private feed here; the scene draws it.
    houseFeed?: (update: FeedUpdate) => void;
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

const FRAME_MS = 66;

// Draws the room onto a canvas about 15 times a second until the returned
// function is called. requestAnimationFrame is the clock, but a page the
// browser counts as hidden gets it throttled to a crawl or stopped, which
// would freeze the video the phones watch; the interval redraws when a frame
// is overdue, so the picture keeps moving either way.
function startCanvas(roomId: string) {
  const canvas = document.createElement('canvas');
  canvas.width = STAMP.canvasWidth;
  canvas.height = STAMP.canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  const scene = createScene(roomId);
  window.houseFeed = (update) => scene.apply(update, Date.now());

  let last = 0;
  let raf = 0;
  const frame = () => {
    const now = Date.now();
    if (now - last >= FRAME_MS) {
      last = now;
      scene.draw(ctx, now);
    }
  };
  const tick = () => {
    frame();
    raf = requestAnimationFrame(tick);
  };
  frame();
  tick();
  const overdue = setInterval(() => Date.now() - last >= FRAME_MS * 3 && frame(), FRAME_MS * 3);

  const stop = () => {
    cancelAnimationFrame(raf);
    clearInterval(overdue);
    window.houseFeed = undefined;
  };
  return { canvas, stop };
}

async function publish(info: JoinInfo, set: (s: State) => void) {
  const { Room, RoomEvent, LocalVideoTrack, createLocalAudioTrack } = await import('livekit-client');
  const room = new Room();
  room.on(RoomEvent.Disconnected, () => set('error'));
  await room.connect(info.url, info.token);
  const tracks: LocalTrack[] = [];
  let stopCanvas = () => {};
  const leave = async () => {
    stopCanvas();
    tracks.forEach((t) => t.stop());
    await room.disconnect();
  };
  try {
    const mic = await createLocalAudioTrack(RAW_AUDIO);
    tracks.push(mic);
    await room.localParticipant.publishTrack(mic);
    if (info.kind === 'VIDEO') {
      const drawing = startCanvas(info.room);
      stopCanvas = drawing.stop;
      const cam = new LocalVideoTrack(drawing.canvas.captureStream(15).getVideoTracks()[0]);
      tracks.push(cam);
      // One layer at a fixed bitrate: a simulcast ladder would send the node
      // three copies of a 360p picture it serves to 20 phones at most.
      await room.localParticipant.publishTrack(cam, {
        simulcast: false,
        videoEncoding: { maxBitrate: 800_000, maxFramerate: 15 },
      });
    }
  } catch (err) {
    // The caller never gets a leave function for a publish that failed, so a
    // half-published house would stay connected with its mic open.
    await leave().catch(() => {});
    throw err;
  }
  set('publishing');
  return leave;
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
