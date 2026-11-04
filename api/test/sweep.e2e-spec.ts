import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { EgressService } from '../src/egress/egress.service';
import { EventsService } from '../src/events/events.service';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { JOINED_MS, markJoined } from '../src/rooms/joined';
import { LiveKitRooms } from '../src/rooms/livekit-rooms';
import { SeatSweep } from '../src/rooms/seat-sweep';
import { seedHouseRooms } from '../src/seed';
import { bootApp, flushRedis, resetDb } from './helpers';

// Stands in for the node: who is connected where, and what the API asked to drop.
class FakeNode implements LiveKitRooms {
  seats = new Map<string, string[]>();
  listed: string[] = [];
  removed: [string, string][] = [];
  failList = new Set<string>();
  failRemove = new Set<string>();

  async participants(room: string) {
    this.listed.push(room);
    if (this.failList.has(room)) throw new Error('livekit unreachable');
    return [...(this.seats.get(room) ?? [])];
  }

  async remove(room: string, identity: string) {
    if (this.failRemove.has(identity)) throw new Error('remove failed');
    this.removed.push([room, identity]);
    this.seats.set(room, (this.seats.get(room) ?? []).filter((i) => i !== identity));
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('seat sweep', () => {
  let node: FakeNode;
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let sweeper: SeatSweep;
  let video: Room;
  let audio: Room;
  let at: number;

  beforeAll(async () => {
    node = new FakeNode();
    app = await bootApp({ livekitRooms: node });
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
    sweeper = app.get(SeatSweep);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    node.seats.clear();
    node.listed = [];
    node.removed = [];
    node.failList.clear();
    node.failRemove.clear();
    at = Date.now();
    jest.spyOn(app.get(CLOCK), 'now').mockImplementation(() => at);
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    video = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
    audio = (await prisma.room.findFirst({ where: { house: true, kind: 'AUDIO' } }))!;
  });

  afterAll(async () => {
    await app.close();
  });

  const hood = async () => (await app.get(EventsService).recent()).map((e) => e.text);
  const month = () => new Date(at).toISOString().slice(0, 7);

  it('removes the seat whose join proof is missing and leaves the house and a fresh guest', async () => {
    node.seats.set(video.id, ['house', 'guest-a', 'guest-b']);
    await markJoined(redis, video.id, 'guest-a', at);
    expect(await sweeper.sweep(at)).toBe(1);
    expect(node.removed).toEqual([[video.id, 'guest-b']]);
    await until(async () => (await hood()).some((t) => t.startsWith('seat removed · video time used')));
  });

  it('removes a seat once its proof has run out, 15 minutes after the join', async () => {
    node.seats.set(video.id, ['guest-a']);
    await markJoined(redis, video.id, 'guest-a', at);
    expect(await sweeper.sweep(at + JOINED_MS - 1)).toBe(0);
    expect(await sweeper.sweep(at + JOINED_MS + 1)).toBe(1);
    expect(node.removed).toEqual([[video.id, 'guest-a']]);
  });

  it('does not sweep audio rooms', async () => {
    node.seats.set(audio.id, ['house', 'guest-b']);
    expect(await sweeper.sweep(at)).toBe(0);
    expect(node.listed).not.toContain(audio.id);
    expect(node.removed).toEqual([]);
  });

  it('does not sweep a room that has ended', async () => {
    await prisma.room.update({ where: { id: video.id }, data: { status: 'ENDED' } });
    node.seats.set(video.id, ['guest-b']);
    expect(await sweeper.sweep(at)).toBe(0);
    expect(node.listed).toEqual([]);
  });

  it('removes every guest while the budget is paused, proof or not, and never the house', async () => {
    await redis.set(`eg:month:${month()}`, String(0.8 * 20e12));
    node.seats.set(video.id, ['house', 'guest-a', 'guest-b']);
    await markJoined(redis, video.id, 'guest-a', at);
    expect(await sweeper.sweep(at)).toBe(2);
    expect(node.removed.map(([, who]) => who).sort()).toEqual(['guest-a', 'guest-b']);
    expect(node.seats.get(video.id)).toEqual(['house']);
    await until(async () => (await hood()).some((t) => t.startsWith('seat removed · video paused')));
  });

  it('keeps going when LiveKit fails on one room', async () => {
    const other = await prisma.room.create({
      data: { kind: 'VIDEO', title: 'Second', hostName: 'someone', house: false, status: 'LIVE' },
    });
    node.failList.add(video.id);
    node.seats.set(other.id, ['guest-b']);
    await expect(sweeper.sweep(at)).resolves.toBe(1);
    expect(node.removed).toEqual([[other.id, 'guest-b']]);
  });

  it('keeps going when one removal fails', async () => {
    node.failRemove.add('guest-b');
    node.seats.set(video.id, ['guest-b', 'guest-c']);
    await expect(sweeper.sweep(at)).resolves.toBe(1);
    expect(node.removed).toEqual([[video.id, 'guest-c']]);
  });

  describe('from the sampler', () => {
    beforeEach(() => {
      at = Math.floor(at / 10_000) * 10_000;
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    });

    it('runs once per slot however many replicas there are', async () => {
      const other = await bootApp({ replica: 'b', livekitRooms: node });
      try {
        jest.spyOn(other.get(CLOCK), 'now').mockImplementation(() => at);
        node.seats.set(video.id, ['guest-b']);
        expect(await app.get(EgressService).sample()).toBe(true);
        at += 3_000;
        expect(await other.get(EgressService).sample()).toBe(false);
        expect(node.listed).toEqual([video.id]);
        expect(node.removed).toEqual([[video.id, 'guest-b']]);
        at += 7_000;
        expect(await other.get(EgressService).sample()).toBe(true);
        expect(node.listed).toEqual([video.id, video.id]);
      } finally {
        await other.close();
      }
    });

    it('still writes the series point when the sweep throws', async () => {
      jest.spyOn(sweeper, 'sweep').mockRejectedValue(new Error('mongo went away'));
      await app.get(EgressService).sample();
      const res = await request(app.getHttpServer()).get('/bandwidth').expect(200);
      expect(res.body.series).toHaveLength(1);
    });
  });
});
