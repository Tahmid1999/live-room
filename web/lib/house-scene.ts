// What the video room shows: the house page draws this onto a 640x360 canvas
// and publishes the canvas as the video track. State and drawing live here,
// apart from the page, so the state can be tested without a browser.
import { drawStamp, STAMP } from './stamp';

export type FeedUpdate =
  | { type: 'gift'; roomId: string; name: string; giftId: string; coins: number; replica: string; tap: string; t: number }
  | { type: 'join'; roomId: string; name: string; t: number }
  | { type: 'viewers'; roomId: string; count: number; t: number }
  // No room id: this is the server's own egress, not one room's.
  | { type: 'bandwidth'; bps: number; usedBytes: number; budgetBytes: number };

export type Card = { text: string; kind: 'gift' | 'join'; at: number };
type Falling = { giftId: string; x: number; at: number };

export const CARD_MS = 4000;
export const FALL_MS = 2600;
export const MAX_CARDS = 4;

const WIDTH = STAMP.canvasWidth;
const STRIP_TOP = STAMP.canvasHeight - STAMP.height;

// Same ids and names as api/src/wallet/gifts.ts and the phone's gift buttons.
const GIFT_NAMES: Record<string, string> = {
  tea: 'Tea',
  rose: 'Rose',
  clap: 'Clap',
  star: 'Star',
  crown: 'Crown',
};
const giftName = (id: string) => GIFT_NAMES[id] ?? id;

// The phone app's palette (app/globals.css).
const COLORS = {
  bg: '#f3efe4',
  ink: '#1b2a4a',
  ink2: '#4d5974',
  line: '#cdc6b0',
  panel: '#e9e4d3',
  field: '#fbf9f2',
  red: '#d9432b',
};
const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';

function rate(bps: number): string {
  return bps < 1e5 ? `${Math.round(bps / 1000)} kbps` : `${(bps / 1e6).toFixed(1)} Mbps`;
}

// TB from a terabyte up, GB below it, as the phone's meter reads. The month's
// use keeps its decimal; the budget drops a trailing .0.
function size(n: number, keepDecimal: boolean): string {
  const [value, unit] = n >= 1e12 ? [n / 1e12, 'TB'] : [n / 1e9, 'GB'];
  return `${keepDecimal ? value.toFixed(1) : +value.toFixed(1)} ${unit}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// The house machine's local time. The big clock shows tenths; the line above
// the strip shows milliseconds, so a person can check it against the age the
// phone reads from the strip.
export function clockText(now: number): string {
  const d = new Date(now);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

export function drawnAtText(now: number): string {
  const d = new Date(now);
  return `frame drawn at ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export type Meter = { watching: string; month: string; fill: number };

export type Scene = {
  apply(update: FeedUpdate, now: number): void;
  draw(ctx: CanvasRenderingContext2D, now: number): void;
  cards(now: number): Card[];
  falling(now: number): Falling[];
  tap(now: number): string | null;
  meter(): Meter | null;
};

export function createScene(roomId: string, title = 'Live Room'): Scene {
  let cards: Card[] = [];
  let falling: Falling[] = [];
  let tap: { code: string; at: number } | null = null;
  let watching = 0;
  let bandwidth: { bps: number; usedBytes: number; budgetBytes: number } | null = null;
  let dropped = 0;

  const addCard = (card: Card) => {
    cards = [...cards, card].slice(-MAX_CARDS);
  };

  const scene: Scene = {
    apply(update, now) {
      if (update.type === 'bandwidth') {
        bandwidth = { bps: update.bps, usedBytes: update.usedBytes, budgetBytes: update.budgetBytes };
        return;
      }
      if (update.roomId !== roomId) return;
      if (update.type === 'viewers') {
        watching = update.count;
      } else if (update.type === 'join') {
        addCard({ text: `${update.name} joined`, kind: 'join', at: now });
      } else {
        addCard({
          text: `${update.name} sent ${giftName(update.giftId)} · handled by ${update.replica}`,
          kind: 'gift',
          at: now,
        });
        // Spread by count, not by chance, so a burst of one gift does not
        // stack its icons on one spot.
        const x = 0.1 + ((dropped++ * 0.37) % 0.8);
        falling = [...falling.filter((f) => now - f.at < FALL_MS), { giftId: update.giftId, x, at: now }];
        tap = { code: update.tap, at: now };
      }
    },
    cards: (now) => cards.filter((c) => now - c.at < CARD_MS),
    falling: (now) => falling.filter((f) => now - f.at < FALL_MS),
    tap: (now) => (tap && now - tap.at < CARD_MS ? tap.code : null),
    meter: () =>
      bandwidth && {
        watching: `${watching} watching · ${rate(bandwidth.bps)}`,
        month: `this month ${size(bandwidth.usedBytes, true)} of ${size(bandwidth.budgetBytes, false)}`,
        fill: bandwidth.budgetBytes > 0 ? Math.max(0, Math.min(1, bandwidth.usedBytes / bandwidth.budgetBytes)) : 0,
      },
    draw(ctx, now) {
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, WIDTH, STRIP_TOP);
      drawHeader(ctx, title);
      drawClock(ctx, now);
      drawMeter(ctx, scene.meter());
      scene.cards(now).forEach((card, i) => drawCard(ctx, card, 136 + i * 40));
      for (const f of scene.falling(now)) {
        const progress = (now - f.at) / FALL_MS;
        drawIcon(ctx, f.giftId, 440 + f.x * 180, 60 + progress * 220, 1 - progress);
      }
      drawDrawnAt(ctx, now);
      // Last, so nothing above can paint over the strip the phone decodes.
      drawStamp(ctx, now, scene.tap(now));
    },
  };
  return scene;
}

function drawHeader(ctx: CanvasRenderingContext2D, title: string) {
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(16, 14, 56, 24);
  ctx.fillStyle = '#fff';
  ctx.font = `500 15px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('LIVE', 44, 27);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'left';
  ctx.font = `500 20px ${MONO}`;
  ctx.fillText(title, 86, 27);
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(16, 48, WIDTH - 32, 2);
}

// Right of the meter and cards, in the column the gift icons fall through; the
// icons are drawn after it and fade as they go, so they cross it, not hide it.
function drawClock(ctx: CanvasRenderingContext2D, now: number) {
  ctx.fillStyle = COLORS.ink;
  ctx.font = `500 30px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(clockText(now), 530, 92);
}

// Just above the strip, which is machine-readable only.
function drawDrawnAt(ctx: CanvasRenderingContext2D, now: number) {
  ctx.fillStyle = COLORS.ink2;
  ctx.font = `400 12px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(drawnAtText(now), 16, STRIP_TOP - 12);
}

function drawMeter(ctx: CanvasRenderingContext2D, meter: Meter | null) {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(16, 60, 400, 62);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.ink;
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText(meter ? meter.watching : 'waiting for numbers', 28, 80);
  ctx.fillStyle = COLORS.ink2;
  ctx.font = `400 14px ${MONO}`;
  ctx.fillText(meter ? meter.month : 'what this room costs my server', 28, 102);
  // The month's transfer against its budget, as a thin bar.
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(28, 112, 376, 4);
  if (meter && meter.fill > 0) {
    ctx.fillStyle = COLORS.red;
    // At least a pixel or two, so a nearly empty month still shows a mark.
    ctx.fillRect(28, 112, Math.max(2, 376 * meter.fill), 4);
  }
}

function drawCard(ctx: CanvasRenderingContext2D, card: Card, y: number) {
  ctx.fillStyle = COLORS.field;
  ctx.fillRect(16, y, 400, 34);
  ctx.fillStyle = card.kind === 'gift' ? COLORS.red : COLORS.ink2;
  ctx.fillRect(16, y, 5, 34);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'left';
  ctx.font = `400 13px ${MONO}`;
  ctx.fillText(card.text, 30, y + 17);
}

// Plain shapes: the picture is squeezed to 800 kbps, so detail would be lost.
function drawIcon(ctx: CanvasRenderingContext2D, giftId: string, x: number, y: number, alpha: number) {
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha * 1.5));
  ctx.fillStyle = COLORS.red;
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 4;
  ctx.beginPath();
  switch (giftId) {
    case 'tea':
      ctx.arc(x + 12, y + 1, 7, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.fillRect(x - 14, y - 10, 24, 22);
      break;
    case 'rose':
      ctx.arc(x, y - 6, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y + 6);
      ctx.lineTo(x, y + 24);
      ctx.strokeStyle = COLORS.ink;
      ctx.stroke();
      break;
    case 'clap':
      ctx.arc(x - 8, y, 10, 0, Math.PI * 2);
      ctx.moveTo(x + 18, y);
      ctx.arc(x + 8, y, 10, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'crown':
      ctx.moveTo(x - 16, y + 10);
      ctx.lineTo(x - 16, y - 8);
      ctx.lineTo(x - 7, y);
      ctx.lineTo(x, y - 12);
      ctx.lineTo(x + 7, y);
      ctx.lineTo(x + 16, y - 8);
      ctx.lineTo(x + 16, y + 10);
      ctx.closePath();
      ctx.fill();
      break;
    default:
      // The star, and any gift this file has not been taught about.
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 7 : 16;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
  }
  ctx.globalAlpha = 1;
}
