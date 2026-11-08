// A strip of black and white blocks along the bottom edge of the room canvas.
// It carries the frame's draw time and the newest gift's tap code, so the phone
// can read both back from the decoded video and measure the delay end to end.
//
// Layout, in slots filled left to right and then row by row:
//   slot 0        black reference
//   slot 1        white reference
//   slots 2-5     fixed start pattern
//   slots 6-77    72 data bits: 48 of ms, 16 of tap, 8 of CRC-8 over those 64
// The slots after the data stay black.
//
// The phone samples a 160x90 copy, a quarter of the canvas, so a 20x16 block is
// 5x4 px there. Blocks are wider than tall because the sampler has more pixels
// to spare horizontally; 3 rows of 32 keep the strip at 48 px, 13% of the height.

export const STAMP = {
  canvasWidth: 640,
  canvasHeight: 360,
  blockWidth: 20,
  blockHeight: 16,
  cols: 32,
  rows: 3,
  height: 48,
} as const;

const REF_BLACK = 0;
const REF_WHITE = 1;
const START = [1, 1, 0, 1];
const START_AT = 2;
const DATA_AT = START_AT + START.length;
const MS_BITS = 48;
const TAP_BITS = 16;
const SUM_BITS = 8;
const DATA_BITS = MS_BITS + TAP_BITS + SUM_BITS;
const MS_RANGE = 2 ** MS_BITS;
// Below this the black and white references are not two separate levels, so
// there is no threshold worth trusting (an empty or grey frame).
const MIN_CONTRAST = 100;

// CRC-8 rather than an XOR so that two flipped bits are caught as well as one.
function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function bitsOf(value: number, count: number): number[] {
  const bits: number[] = [];
  for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2);
  return bits;
}

function valueOf(bits: number[]): number {
  return bits.reduce((acc, bit) => acc * 2 + bit, 0);
}

function payloadBytes(ms: number, tap: number): number[] {
  const bits = [...bitsOf(ms, MS_BITS), ...bitsOf(tap, TAP_BITS)];
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(valueOf(bits.slice(i, i + 8)));
  return bytes;
}

export function drawStamp(ctx: CanvasRenderingContext2D, ms: number, tap: string | null): void {
  if (tap !== null && !/^[0-9a-f]{4}$/i.test(tap)) throw new Error('tap must be 4 hex characters');
  const time = ((Math.floor(ms) % MS_RANGE) + MS_RANGE) % MS_RANGE;
  const tapValue = tap === null ? 0 : parseInt(tap, 16);

  const slots = new Array<number>(STAMP.cols * STAMP.rows).fill(0);
  slots[REF_WHITE] = 1;
  START.forEach((bit, i) => (slots[START_AT + i] = bit));
  const data = [
    ...bitsOf(time, MS_BITS),
    ...bitsOf(tapValue, TAP_BITS),
    ...bitsOf(crc8(payloadBytes(time, tapValue)), SUM_BITS),
  ];
  data.forEach((bit, i) => (slots[DATA_AT + i] = bit));

  const top = STAMP.canvasHeight - STAMP.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, top, STAMP.canvasWidth, STAMP.height);
  ctx.fillStyle = '#fff';
  slots.forEach((bit, i) => {
    if (!bit) return;
    const col = i % STAMP.cols;
    const row = Math.floor(i / STAMP.cols);
    ctx.fillRect(col * STAMP.blockWidth, top + row * STAMP.blockHeight, STAMP.blockWidth, STAMP.blockHeight);
  });
}

export function readStamp(
  px: Uint8ClampedArray,
  width: number,
  height: number,
): { ms: number; tap: string | null } | null {
  if (width < STAMP.cols * 2 || px.length < width * height * 4) return null;
  const sx = width / STAMP.canvasWidth;
  const sy = height / STAMP.canvasHeight;
  const top = STAMP.canvasHeight - STAMP.height;
  // Average a small window around the block centre: the edges are blurred by
  // scaling and compression, the middle of a block is not.
  const rx = Math.floor((STAMP.blockWidth * sx) / 5);
  const ry = Math.floor((STAMP.blockHeight * sy) / 5);

  const luma = (slot: number): number => {
    const col = slot % STAMP.cols;
    const row = Math.floor(slot / STAMP.cols);
    const cx = Math.floor((col + 0.5) * STAMP.blockWidth * sx);
    const cy = Math.floor((top + (row + 0.5) * STAMP.blockHeight) * sy);
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, cy - ry); y <= Math.min(height - 1, cy + ry); y++) {
      for (let x = Math.max(0, cx - rx); x <= Math.min(width - 1, cx + rx); x++) {
        const i = (y * width + x) * 4;
        sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        n++;
      }
    }
    return sum / n;
  };

  const black = luma(REF_BLACK);
  const white = luma(REF_WHITE);
  if (white - black < MIN_CONTRAST) return null;
  const threshold = (black + white) / 2;
  const bit = (slot: number) => (luma(slot) > threshold ? 1 : 0);

  if (START.some((expected, i) => bit(START_AT + i) !== expected)) return null;

  const data: number[] = [];
  for (let i = 0; i < DATA_BITS; i++) data.push(bit(DATA_AT + i));
  const ms = valueOf(data.slice(0, MS_BITS));
  const tap = valueOf(data.slice(MS_BITS, MS_BITS + TAP_BITS));
  const sum = valueOf(data.slice(MS_BITS + TAP_BITS));
  if (crc8(payloadBytes(ms, tap)) !== sum) return null;

  return { ms, tap: tap === 0 ? null : tap.toString(16).padStart(4, '0') };
}
