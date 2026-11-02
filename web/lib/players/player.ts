import type { JoinInfo } from '../api';

export type Player = {
  start(el: HTMLElement, info: JoinInfo): Promise<void>;
  stop(): Promise<void>;
  // Bits per second received over the last measuring interval.
  bitrate(): number;
};
