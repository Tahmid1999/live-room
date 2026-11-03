// Opus goes quiet in silence but never stops sending, and video never does,
// so ten seconds without a single new byte means the publisher is stuck.
export const STALL_MS = 10_000;

// Fed the bytes sent, summed over the page's open peer connections. An SDK
// that reconnects closes one connection and opens another, so the sum can go
// down as well as up; either way bytes are moving, and the new sum is the
// baseline from then on.
export class SendProgress {
  private bytes = 0;
  private movedAt: number;

  constructor(now: number) {
    this.movedAt = now;
  }

  moving(bytes: number, now: number): boolean {
    if (bytes !== this.bytes) {
      this.bytes = bytes;
      this.movedAt = now;
    }
    return now - this.movedAt < STALL_MS;
  }
}
