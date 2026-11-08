import { expect, test } from '@playwright/test';
import { clockText, createScene, drawnAtText, type FeedUpdate } from '../lib/house-scene';

const ROOM = 'room-1';
const gift = (t: number, over: Partial<Extract<FeedUpdate, { type: 'gift' }>> = {}): FeedUpdate => ({
  type: 'gift',
  roomId: ROOM,
  name: 'guest-1751',
  giftId: 'rose',
  coins: 50,
  replica: 'api-2',
  tap: 'a1b2',
  t,
  ...over,
});

test('a gift adds a card with who sent what and which replica handled it', () => {
  const scene = createScene(ROOM);
  scene.apply(gift(0), 0);
  expect(scene.cards(0).map((c) => c.text)).toEqual(['guest-1751 sent Rose · handled by api-2']);
});

test('a join adds a card', () => {
  const scene = createScene(ROOM);
  scene.apply({ type: 'join', roomId: ROOM, name: 'guest-2204', t: 0 }, 0);
  expect(scene.cards(0).map((c) => c.text)).toEqual(['guest-2204 joined']);
});

test('a fifth card drops the oldest', () => {
  const scene = createScene(ROOM);
  for (let i = 1; i <= 5; i++) scene.apply(gift(i, { name: `guest-${i}` }), i);
  const texts = scene.cards(5).map((c) => c.text);
  expect(texts).toHaveLength(4);
  expect(texts[0]).toContain('guest-2');
  expect(texts[3]).toContain('guest-5');
});

test('cards expire after 4 s', () => {
  const scene = createScene(ROOM);
  scene.apply(gift(0), 1000);
  expect(scene.cards(4999)).toHaveLength(1);
  expect(scene.cards(5000)).toHaveLength(0);
});

test('the stamp tap is the newest gift tap for 4 s, then null', () => {
  const scene = createScene(ROOM);
  expect(scene.tap(0)).toBeNull();
  scene.apply(gift(0, { tap: 'aaaa' }), 1000);
  scene.apply(gift(0, { tap: 'bbbb' }), 2000);
  expect(scene.tap(2000)).toBe('bbbb');
  expect(scene.tap(5999)).toBe('bbbb');
  expect(scene.tap(6000)).toBeNull();
});

test('a falling icon lasts 2.6 s', () => {
  const scene = createScene(ROOM);
  scene.apply(gift(0), 0);
  expect(scene.falling(2599)).toHaveLength(1);
  expect(scene.falling(2600)).toHaveLength(0);
});

test('the meter waits for numbers, then reads viewers and bandwidth', () => {
  const scene = createScene(ROOM);
  expect(scene.meter()).toBeNull();
  scene.apply({ type: 'viewers', roomId: ROOM, count: 3, t: 0 }, 0);
  scene.apply({ type: 'bandwidth', bps: 1_500_000, usedBytes: 2e9, budgetBytes: 1e12 }, 0);
  expect(scene.meter()).toEqual({ watching: '3 watching · 1.5 Mbps', month: 'this month 2.0 GB of 1 TB', fill: 0.002 });
});

test('the fill is the month used over the budget, held between 0 and 1', () => {
  const scene = createScene(ROOM);
  scene.apply({ type: 'bandwidth', bps: 0, usedBytes: 5e12, budgetBytes: 20e12 }, 0);
  expect(scene.meter()?.fill).toBe(0.25);
  scene.apply({ type: 'bandwidth', bps: 0, usedBytes: 25e12, budgetBytes: 20e12 }, 0);
  expect(scene.meter()?.fill).toBe(1);
  scene.apply({ type: 'bandwidth', bps: 0, usedBytes: 1, budgetBytes: 0 }, 0);
  expect(scene.meter()?.fill).toBe(0);
});

test('the clocks read the draw time as local hh:mm:ss.d and hh:mm:ss.mmm', () => {
  const at = new Date(2026, 0, 1, 7, 4, 9, 678).getTime();
  expect(clockText(at)).toBe('07:04:09.6');
  expect(drawnAtText(at)).toBe('frame drawn at 07:04:09.678');
});

test('updates for another room are ignored', () => {
  const scene = createScene(ROOM);
  scene.apply(gift(0, { roomId: 'other' }), 0);
  scene.apply({ type: 'join', roomId: 'other', name: 'guest-1', t: 0 }, 0);
  scene.apply({ type: 'viewers', roomId: 'other', count: 9, t: 0 }, 0);
  scene.apply({ type: 'bandwidth', bps: 1e6, usedBytes: 0, budgetBytes: 1e12 }, 0);
  expect(scene.cards(0)).toHaveLength(0);
  expect(scene.falling(0)).toHaveLength(0);
  expect(scene.tap(0)).toBeNull();
  expect(scene.meter()?.watching).toBe('0 watching · 1.0 Mbps');
});

test('a frame with no updates still draws, stamp last', () => {
  const scene = createScene(ROOM);
  const texts: string[] = [];
  let lastFill = '';
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : key === 'fillText'
          ? (text: string) => texts.push(text)
          : key === 'fillRect'
            ? () => (lastFill = String(target.fillStyle))
            : () => {},
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  const at = new Date(2026, 0, 1, 12, 0, 0, 250).getTime();
  scene.draw(ctx, at);
  expect(texts).toContain('Live Room');
  expect(texts).toContain('12:00:00.2');
  expect(texts).toContain('frame drawn at 12:00:00.250');
  expect(texts).toContain('waiting for numbers');
  // The stamp paints white blocks on black, and nothing paints after it.
  expect(['#fff', '#000']).toContain(lastFill);
});

test('the canvas prints the room title it was given', () => {
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (key === 'fillText' ? (text: string) => texts.push(text) : (target[key] ?? (() => {}))),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  createScene(ROOM, 'Desk camera').draw(ctx, 0);
  expect(texts).toContain('Desk camera');
  expect(texts).not.toContain('Live Room');
});
