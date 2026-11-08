import { expect, test } from '@playwright/test';
import { drawStamp, readStamp, STAMP } from '../lib/stamp';

const W = STAMP.canvasWidth;
const H = STAMP.canvasHeight;

// The smallest context drawStamp needs: a fillStyle and fillRect into RGBA.
function render(ms: number, tap: string | null) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i += 4) px.set([128, 128, 128, 255], i);
  let level = 0;
  const ctx = {
    set fillStyle(v: string) {
      level = v === '#fff' ? 255 : 0;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) px.set([level, level, level, 255], (yy * W + xx) * 4);
    },
  } as unknown as CanvasRenderingContext2D;
  drawStamp(ctx, ms, tap);
  return px;
}

// Box filter, like a video scaler would.
function downscale(px: Uint8ClampedArray, w: number, h: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = W / w;
  const fy = H / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let yy = y * fy; yy < (y + 1) * fy; yy++)
          for (let xx = x * fx; xx < (x + 1) * fx; xx++) sum += px[(yy * W + xx) * 4 + c];
        out[(y * w + x) * 4 + c] = Math.round(sum / (fx * fy));
      }
  return out;
}

function noisy(px: Uint8ClampedArray, amount: number) {
  const out = new Uint8ClampedArray(px);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < out.length; i++) if (i % 4 !== 3) out[i] += Math.round(rand() * amount);
  return out;
}

function invertSlot(px: Uint8ClampedArray, slot: number) {
  const x0 = (slot % STAMP.cols) * STAMP.blockWidth;
  const y0 = H - STAMP.height + Math.floor(slot / STAMP.cols) * STAMP.blockHeight;
  for (let y = y0; y < y0 + STAMP.blockHeight; y++)
    for (let x = x0; x < x0 + STAMP.blockWidth; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = 255 - px[i + c];
    }
}

const MS = 1_762_700_000_123;

test('round-trips at 640x360', () => {
  expect(readStamp(render(MS, 'a3f0'), W, H)).toEqual({ ms: MS, tap: 'a3f0' });
});

test('round-trips at 320x180', () => {
  expect(readStamp(downscale(render(MS, 'a3f0'), 320, 180), 320, 180)).toEqual({ ms: MS, tap: 'a3f0' });
});

test('round-trips at 160x90, the size the phone samples', () => {
  expect(readStamp(downscale(render(MS, 'a3f0'), 160, 90), 160, 90)).toEqual({ ms: MS, tap: 'a3f0' });
});

test('survives +-40 noise on every channel at all three sizes', () => {
  const full = render(MS, 'beef');
  for (const [w, h] of [[640, 360], [320, 180], [160, 90]]) {
    const px = w === W ? full : downscale(full, w, h);
    expect(readStamp(noisy(px, 40), w, h)).toEqual({ ms: MS, tap: 'beef' });
  }
});

test('survives colours drifting toward grey', () => {
  const px = downscale(render(MS, '00ff'), 160, 90);
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = 30 + px[i + c] * 0.75;
  expect(readStamp(px, 160, 90)).toEqual({ ms: MS, tap: '00ff' });
});

test('no tap round-trips as null', () => {
  expect(readStamp(render(MS, null), W, H)).toEqual({ ms: MS, tap: null });
});

test('keeps the low 48 bits of ms', () => {
  expect(readStamp(render(2 ** 48 + 5, null), W, H)?.ms).toBe(5);
});

test('draws only inside the bottom strip', () => {
  const px = render(MS, 'a3f0');
  let touched = 0;
  for (let y = 0; y < H - STAMP.height; y++)
    for (let x = 0; x < W; x++) if (px[(y * W + x) * 4] !== 128) touched++;
  expect(touched).toBe(0);
});

test('a flipped data bit fails the checksum', () => {
  const px = render(MS, 'a3f0');
  invertSlot(px, 40);
  expect(readStamp(px, W, H)).toBeNull();
});

test('every single flipped slot of the payload is rejected', () => {
  const base = render(MS, 'a3f0');
  for (let slot = 6; slot < 78; slot++) {
    const px = new Uint8ClampedArray(base);
    invertSlot(px, slot);
    expect(readStamp(px, W, H), `slot ${slot}`).toBeNull();
  }
});

test('an all-grey frame reads as null', () => {
  const px = new Uint8ClampedArray(W * H * 4).fill(128);
  expect(readStamp(px, W, H)).toBeNull();
  expect(readStamp(downscale(px, 160, 90), 160, 90)).toBeNull();
});

test('rejects a malformed tap', () => {
  expect(() => drawStamp({} as CanvasRenderingContext2D, MS, 'xyz')).toThrow();
});
