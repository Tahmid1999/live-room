import { INestApplication } from '@nestjs/common';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import { CLOCK } from '../src/clock';
import { EventsService } from '../src/events/events.service';
import { markPresent, viewerCount } from '../src/presence';
import { markJoined } from '../src/rooms/joined';
import { PrismaService } from '../src/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, flushRedis, resetDb } from './helpers';

function liveKitClaims(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

describe('rooms', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let video: Room;
  let audio: Room;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    redis = app.get(REDIS);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    video = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;
    audio = (await prisma.room.findFirst({ where: { house: true, kind: 'AUDIO' } }))!;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  // one cookie jar, so repeated joins are one guest and do not trip the guest-creation limit
  const viewer = () => request.agent(server());

  // The counter the sampler fills; the test budget is 20 TB a month.
  const monthKey = () => `eg:month:${new Date().toISOString().slice(0, 7)}`;

  const crowd = (roomId: string, size: number, at: number) =>
    redis.zadd(`viewers:${roomId}`, ...Array.from({ length: size }, (_, i) => [at, `g${i}`]).flat());

  describe('list', () => {
    it('shows live rooms with a counted viewer number', async () => {
      await markPresent(redis, audio.id, 'g1', Date.now());
      await markPresent(redis, audio.id, 'g2', Date.now());
      const res = await request(server()).get('/rooms').expect(200);
      expect(res.body).toEqual([
        {
          id: video.id, kind: 'VIDEO', title: 'Desk camera',
          hostName: 'house', house: true, viewers: 0, startsOnOpen: true,
        },
        {
          id: audio.id, kind: 'AUDIO', title: 'Late radio',
          hostName: 'house', house: true, viewers: 2, startsOnOpen: false,
        },
      ]);
    });

    it('hides a killed room', async () => {
      await prisma.room.update({ where: { id: audio.id }, data: { status: 'KILLED' } });
      const res = await request(server()).get('/rooms').expect(200);
      expect(res.body.map((r: { id: string }) => r.id)).toEqual([video.id]);
    });
  });

  describe('join', () => {
    it.each([
      ['video', () => video, 'VIDEO'],
      ['audio', () => audio, 'AUDIO'],
    ] as const)('gives a %s viewer a livekit token that cannot publish', async (_name, room, kind) => {
      const guest = viewer();
      const me = await guest.get('/me');
      const res = await guest.post(`/rooms/${room().id}/join`).expect(200);
      expect(res.body).toEqual({
        kind,
        url: process.env.LIVEKIT_URL,
        room: room().id,
        identity: me.body.id,
        token: expect.any(String),
      });
      const claims = liveKitClaims(res.body.token);
      expect(claims.sub).toBe(me.body.id);
      expect(claims.video).toMatchObject({
        room: room().id,
        roomJoin: true,
        canSubscribe: true,
        canPublish: false,
        canPublishData: false,
        hidden: true,
      });
    });

    it('keeps the same identity for the same guest', async () => {
      const guest = viewer();
      const a = await guest.post(`/rooms/${video.id}/join`).expect(200);
      const b = await guest.post(`/rooms/${video.id}/join`).expect(200);
      expect(b.body.identity).toBe(a.body.identity);
    });

    it('answers 410 for a killed or ended room', async () => {
      await prisma.room.update({ where: { id: video.id }, data: { status: 'KILLED' } });
      await prisma.room.update({ where: { id: audio.id }, data: { status: 'ENDED' } });
      await viewer().post(`/rooms/${video.id}/join`).expect(410);
      await viewer().post(`/rooms/${audio.id}/join`).expect(410);
    });

    it('answers 404 for an unknown or malformed room id', async () => {
      await viewer().post('/rooms/000000000000000000000000/join').expect(404);
      await viewer().post('/rooms/not-an-id/join').expect(404);
    });

    it('refuses video with the exact message at 80% of the transfer budget, and mints nothing', async () => {
      await redis.set(monthKey(), String(0.8 * 20e12));
      const guest = viewer();
      const res = await guest.post(`/rooms/${video.id}/join`).expect(503);
      expect(res.body).toEqual({
        error: 'video paused until the 1st: monthly transfer budget 80% used',
      });
      await guest.post(`/rooms/${audio.id}/join`).expect(200);
    });

    it('lets video in one byte below the line', async () => {
      await redis.set(monthKey(), String(0.8 * 20e12 - 1));
      await viewer().post(`/rooms/${video.id}/join`).expect(200);
    });

    it('refuses the 13th join from one network in the hour', async () => {
      const guest = viewer();
      for (let i = 0; i < 12; i++) await guest.post(`/rooms/${audio.id}/join`).expect(200);
      const res = await guest.post(`/rooms/${audio.id}/join`).expect(429);
      expect(res.body.token).toBeUndefined();
    });

    it('does not spend the allowance on a refused join', async () => {
      const guest = viewer();
      await crowd(audio.id, 50, Date.now());
      for (let i = 0; i < 15; i++) await guest.post(`/rooms/${audio.id}/join`).expect(409);
      await guest.post(`/rooms/${video.id}/join`).expect(200);
    });

    it('is full at 50 audio viewers who reported in the last 15 s', async () => {
      await crowd(audio.id, 50, Date.now() - 1000);
      const res = await viewer().post(`/rooms/${audio.id}/join`).expect(409);
      expect(res.body).toEqual({ error: 'room is full' });
    });

    it('is full at 20 video viewers, where audio still has room', async () => {
      await crowd(video.id, 20, Date.now() - 1000);
      await crowd(audio.id, 20, Date.now() - 1000);
      const res = await viewer().post(`/rooms/${video.id}/join`).expect(409);
      expect(res.body).toEqual({ error: 'room is full' });
      await viewer().post(`/rooms/${audio.id}/join`).expect(200);
    });

    it('lets a viewer in when 19 are watching video or 49 are listening to audio', async () => {
      await crowd(video.id, 19, Date.now() - 1000);
      await crowd(audio.id, 49, Date.now() - 1000);
      await viewer().post(`/rooms/${video.id}/join`).expect(200);
      await viewer().post(`/rooms/${audio.id}/join`).expect(200);
    });

    it.each([
      ['video', () => video, 20],
      ['audio', () => audio, 50],
    ] as const)('does not turn away a viewer who already holds one of the %s places', async (_name, room, cap) => {
      const guest = viewer();
      const me = await guest.get('/me').expect(200);
      await crowd(room().id, cap - 1, Date.now() - 1000);
      await markPresent(redis, room().id, me.body.id, Date.now() - 1000);
      expect(await viewerCount(redis, room().id, Date.now())).toBe(cap);
      await guest.post(`/rooms/${room().id}/join`).expect(200);
    });

    it('still turns away a viewer whose own entry has expired when the room is full', async () => {
      const guest = viewer();
      const me = await guest.get('/me').expect(200);
      await crowd(video.id, 20, Date.now() - 1000);
      await redis.zadd(`viewers:${video.id}`, Date.now() - 20000, me.body.id);
      await guest.post(`/rooms/${video.id}/join`).expect(409);
    });

    it('does not count viewers whose last report is older than 15 s', async () => {
      await crowd(video.id, 20, Date.now() - 20000);
      await viewer().post(`/rooms/${video.id}/join`).expect(200);
    });
  });

  describe('renew', () => {
    // A guest only holds a place once the socket has reported, so tests mark it.
    async function seated(roomId: string) {
      const guest = viewer();
      const me = await guest.get('/me').expect(200);
      await markPresent(redis, roomId, me.body.id, Date.now());
      await markJoined(redis, roomId, me.body.id, Date.now());
      return { guest, id: me.body.id as string };
    }

    it('mints a fresh token of the same shape for a seated viewer', async () => {
      const { guest, id } = await seated(video.id);
      const res = await guest.post(`/rooms/${video.id}/renew`).expect(200);
      expect(res.body).toEqual({
        kind: 'VIDEO',
        url: process.env.LIVEKIT_URL,
        room: video.id,
        identity: id,
        token: expect.any(String),
      });
      expect(liveKitClaims(res.body.token).video).toMatchObject({
        room: video.id,
        canPublish: false,
        canSubscribe: true,
        hidden: true,
      });
    });

    it('renews an audio viewer for the same identity', async () => {
      const { guest, id } = await seated(audio.id);
      const res = await guest.post(`/rooms/${audio.id}/renew`).expect(200);
      expect(res.body).toMatchObject({ kind: 'AUDIO', room: audio.id, identity: id });
    });

    it('does not spend the per-network join allowance', async () => {
      const { guest } = await seated(audio.id);
      for (let i = 0; i < 12; i++) await guest.post(`/rooms/${audio.id}/renew`).expect(200);
      await guest.post(`/rooms/${audio.id}/join`).expect(200);
    });

    it('stops one guest at 12 renewals an hour', async () => {
      const { guest } = await seated(audio.id);
      for (let i = 0; i < 12; i++) await guest.post(`/rooms/${audio.id}/renew`).expect(200);
      const res = await guest.post(`/rooms/${audio.id}/renew`).expect(429);
      expect(res.body.token).toBeUndefined();
    });

    it('refuses someone who is not in the room, or whose heartbeat is stale', async () => {
      const stranger = viewer();
      await stranger.post(`/rooms/${audio.id}/renew`).expect(403);
      const { guest, id } = await seated(audio.id);
      await redis.zadd(`viewers:${audio.id}`, Date.now() - 20000, id);
      await guest.post(`/rooms/${audio.id}/renew`).expect(403);
    });

    it('refuses a viewer who never went through join, even with a live heartbeat', async () => {
      const guest = viewer();
      const me = await guest.get('/me').expect(200);
      await markPresent(redis, audio.id, me.body.id, Date.now());
      const res = await guest.post(`/rooms/${audio.id}/renew`).expect(403);
      expect(res.body).toEqual({ error: 'not in this room' });
    });

    it('cuts video off after six renewals in 24 h until a fresh join, which does not reset it', async () => {
      let at = Date.now();
      jest.spyOn(app.get(CLOCK), 'now').mockImplementation(() => at);
      const { guest, id } = await seated(video.id);
      const reseat = async () => {
        await markPresent(redis, video.id, id, at);
        await markJoined(redis, video.id, id, at);
      };
      for (let i = 0; i < 6; i++) {
        await guest.post(`/rooms/${video.id}/renew`).expect(200);
        at += 10 * 60_000;
        await reseat();
        // The hourly cap is not what this is about.
        await redis.del(`renew:${id}`);
      }
      const res = await guest.post(`/rooms/${video.id}/renew`).expect(403);
      expect(res.body).toEqual({ error: 'still watching? reopen the room' });

      await guest.post(`/rooms/${video.id}/join`).expect(200);
      await guest.post(`/rooms/${video.id}/renew`).expect(403);

      // A day after the first renewal its slot is free again.
      at += 24 * 3600_000 - 60 * 60_000 + 1;
      await reseat();
      await guest.post(`/rooms/${video.id}/renew`).expect(200);
      await guest.post(`/rooms/${video.id}/renew`).expect(403);
    });

    it('does not count audio renewals against the video hour', async () => {
      const { guest, id } = await seated(audio.id);
      await redis.zadd(`renewvideo:${id}`, ...Array.from({ length: 6 }, (_, i) => [Date.now(), `r${i}`]).flat());
      await guest.post(`/rooms/${audio.id}/renew`).expect(200);
    });

    it('answers 410 once the room is killed', async () => {
      const { guest } = await seated(video.id);
      await prisma.room.update({ where: { id: video.id }, data: { status: 'KILLED' } });
      await guest.post(`/rooms/${video.id}/renew`).expect(410);
    });

    it('refuses video with the exact message at 80% of the transfer budget', async () => {
      const { guest } = await seated(video.id);
      await redis.set(monthKey(), String(0.8 * 20e12));
      const res = await guest.post(`/rooms/${video.id}/renew`).expect(503);
      expect(res.body).toEqual({
        error: 'video paused until the 1st: monthly transfer budget 80% used',
      });
    });
  });

  describe('house token', () => {
    const asHouse = (roomId: string, key = process.env.HOUSE_KEY!) =>
      request(server()).post('/house/token').set('x-house-key', key).send({ roomId });

    it('is 401 without the key', async () => {
      await request(server()).post('/house/token').send({ roomId: video.id }).expect(401);
    });

    it('is 401 with a wrong key', async () => {
      await asHouse(video.id, 'not-the-key').expect(401);
      await asHouse(video.id, '').expect(401);
    });

    it.each([
      ['video', () => video, 'VIDEO'],
      ['audio', () => audio, 'AUDIO'],
    ] as const)('gives the %s house host a livekit token that can publish', async (_name, room, kind) => {
      const res = await asHouse(room().id).expect(200);
      expect(res.body).toEqual({
        kind,
        url: process.env.LIVEKIT_URL,
        room: room().id,
        identity: 'house',
        token: expect.any(String),
      });
      const claims = liveKitClaims(res.body.token);
      expect(claims.sub).toBe('house');
      expect(claims.video).toMatchObject({
        room: room().id,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        hidden: false,
      });
    });

    it('refuses a room that is not a house room', async () => {
      const other = await prisma.room.create({
        data: { kind: 'AUDIO', title: 'x', hostName: 'someone', house: false, status: 'LIVE' },
      });
      await asHouse(other.id).expect(404);
    });

    it('is 410 for a killed house room and 400 without a roomId', async () => {
      await prisma.room.update({ where: { id: video.id }, data: { status: 'KILLED' } });
      await asHouse(video.id).expect(410);
      await request(server()).post('/house/token').set('x-house-key', process.env.HOUSE_KEY!).send({}).expect(400);
    });
  });

  describe('house event', () => {
    const send = (body: object, key = process.env.HOUSE_KEY!) =>
      request(server()).post('/house/event').set('x-house-key', key).send(body);
    const houseLines = async () =>
      (await app.get(EventsService).recent()).filter((e) => e.kind === 'house').map((e) => e.text);

    it('is 401 without or with a wrong key', async () => {
      await request(server()).post('/house/event').send({ roomId: video.id, state: 'publishing' }).expect(401);
      await send({ roomId: video.id, state: 'publishing' }, 'not-the-key').expect(401);
      expect(await redis.exists(`house:on:${video.id}`)).toBe(0);
    });

    it('marks the room on for 30 s while publishing and clears it on stopped', async () => {
      await send({ roomId: video.id, state: 'publishing' }).expect(204);
      expect(await redis.ttl(`house:on:${video.id}`)).toBeGreaterThan(25);
      await send({ roomId: video.id, state: 'stopped' }).expect(204);
      expect(await redis.exists(`house:on:${video.id}`)).toBe(0);
    });

    it('refreshes the 30 s window on every publishing call', async () => {
      await send({ roomId: video.id, state: 'publishing' }).expect(204);
      await redis.expire(`house:on:${video.id}`, 5);
      await send({ roomId: video.id, state: 'publishing' }).expect(204);
      expect(await redis.ttl(`house:on:${video.id}`)).toBeGreaterThan(25);
    });

    it('writes a hood line only when the state changes', async () => {
      await send({ roomId: video.id, state: 'publishing' });
      await send({ roomId: video.id, state: 'publishing' });
      await send({ roomId: video.id, state: 'stopped' });
      await send({ roomId: video.id, state: 'stopped' });
      await send({ roomId: audio.id, state: 'publishing' });
      // emit() is fire and forget, so wait for the last line to land
      const deadline = Date.now() + 3000;
      while ((await houseLines()).length < 3) {
        if (Date.now() > deadline) throw new Error('house hood lines did not arrive within 3000 ms');
        await new Promise((r) => setTimeout(r, 20));
      }
      const lines = await houseLines();
      expect(lines.map((l) => l.replace(/ · [^·]+$/, ''))).toEqual([
        'house video room · publishing',
        'house video room · stopped',
        'house audio room · publishing',
      ]);
    });

    it('rejects a bad body, an unknown state, a plain room and a killed room', async () => {
      await send({ state: 'publishing' }).expect(400);
      await send({ roomId: video.id, state: 'on' }).expect(400);
      const other = await prisma.room.create({
        data: { kind: 'AUDIO', title: 'x', hostName: 'someone', house: false, status: 'LIVE' },
      });
      await send({ roomId: other.id, state: 'publishing' }).expect(404);
      await prisma.room.update({ where: { id: video.id }, data: { status: 'KILLED' } });
      await send({ roomId: video.id, state: 'publishing' }).expect(410);
    });
  });

  describe('presence', () => {
    it('counts only viewers newer than 15 s', async () => {
      const now = 1_000_000;
      await markPresent(redis, video.id, 'fresh', now - 14999);
      await markPresent(redis, video.id, 'edge', now - 15000);
      await markPresent(redis, video.id, 'stale', now - 15001);
      expect(await viewerCount(redis, video.id, now)).toBe(1);
    });

    it('counts a viewer once however often they report', async () => {
      for (let i = 0; i < 5; i++) await markPresent(redis, video.id, 'g1', 1_000_000 + i);
      expect(await viewerCount(redis, video.id, 1_000_010)).toBe(1);
    });

    it('drops stale entries when someone reports', async () => {
      await markPresent(redis, video.id, 'old', 1_000_000);
      await markPresent(redis, video.id, 'new', 1_100_000);
      expect(await redis.zrange(`viewers:${video.id}`, 0, -1)).toEqual(['new']);
    });
  });

  describe('seed', () => {
    it('is idempotent', async () => {
      await seedHouseRooms(prisma);
      await seedHouseRooms(prisma);
      const rooms = await prisma.room.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rooms.map((r) => [r.id, r.kind, r.status])).toEqual([
        [video.id, 'VIDEO', 'LIVE'],
        [audio.id, 'AUDIO', 'LIVE'],
      ]);
    });

    it('revives a killed house room and restores its title', async () => {
      await prisma.room.update({
        where: { id: video.id },
        data: { status: 'KILLED', title: 'renamed' },
      });
      await seedHouseRooms(prisma);
      const room = await prisma.room.findUniqueOrThrow({ where: { id: video.id } });
      expect(room).toMatchObject({ status: 'LIVE', title: 'Desk camera' });
      expect(await prisma.room.count()).toBe(2);
    });
  });
});
