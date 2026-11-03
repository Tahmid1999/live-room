import type { JoinInfo } from '../api';

export type PlayerEvents = {
  // true when a remote track starts playing, false when the last one goes.
  onLive(live: boolean): void;
  // A line for the viewer when the stream breaks; '' clears it.
  onProblem(text: string): void;
};

export type Player = {
  start(el: HTMLElement, info: JoinInfo): Promise<void>;
  stop(): Promise<void>;
  // Bits per second received over the last measuring interval.
  bitrate(): number;
};
