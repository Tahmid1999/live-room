// The phone's clock is not the server's, and the stamp in the picture carries
// the house's clock, which is the server's. The offset below turns one into
// the other.

// Server time minus phone time. The server read its clock somewhere between
// the phone sending the request and getting the answer; the midpoint is the
// best guess without knowing which leg was slower.
export function clockOffset(sentAt: number, receivedAt: number, serverNow: number): number {
  return serverNow - (sentAt + receivedAt) / 2;
}

const MAX_AGE_MS = 60_000;

// How old the picture on screen is, in ms. Anything outside 0..60 s is a
// misread stamp or a clock that moved, not an age worth showing.
export function pictureAge(stampMs: number, localNow: number, offset: number): number | null {
  const age = localNow + offset - stampMs;
  return age >= 0 && age <= MAX_AGE_MS ? age : null;
}

export type Stamp = { ms: number; tap: string | null };

// CRC-8 lets about 1 in 256 heavily garbled frames through, so a decode is not
// trusted until it agrees with its neighbours.
const MAX_JUMP_MS = 5000;
// With no stamp for this long the lines go: an old house that draws none, or a
// picture the phone cannot read.
export const STALE_MS = 5000;

export type Accepted = {
  ms: number;
  // A tap code seen in two samples in a row, with the phone time of the first.
  tap: { code: string; firstSeenAt: number } | null;
};

export class StampFilter {
  private last: { ms: number; at: number; tap: string | null; tapSince: number } | null = null;
  // A time that jumped. One alone is a misread; a second near it means the
  // house really did move (restart, new publisher) and is taken as the new base.
  private jumped: number | null = null;

  accept(stamp: Stamp, localNow: number): Accepted | null {
    const prev = this.last;
    if (prev && localNow - prev.at <= STALE_MS && Math.abs(stamp.ms - prev.ms) > MAX_JUMP_MS) {
      const near = this.jumped !== null && Math.abs(stamp.ms - this.jumped) <= MAX_JUMP_MS;
      this.jumped = stamp.ms;
      if (!near) return null;
    }
    this.jumped = null;
    const sameTap = !!stamp.tap && prev?.tap === stamp.tap;
    const tapSince = sameTap ? prev!.tapSince : localNow;
    this.last = { ms: stamp.ms, at: localNow, tap: stamp.tap, tapSince };
    return { ms: stamp.ms, tap: sameTap ? { code: stamp.tap!, firstSeenAt: tapSince } : null };
  }

  reset() {
    this.last = null;
    this.jumped = null;
  }
}

export const SAMPLE_SLOW_MS = 1000;
export const SAMPLE_FAST_MS = 100;
// How long a tap is waited for. The house keeps the code on screen for 4 s, so
// a code not seen by now is not coming.
export const TAP_WAIT_MS = 10_000;

// Once a second is enough for the age, but a tap time read off a 1 s sample
// reads up to 1 s high, so while a tap is pending the picture is read ten
// times a second.
export function sampleIntervalMs(pendingUntil: number, now: number): number {
  return now < pendingUntil ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS;
}
