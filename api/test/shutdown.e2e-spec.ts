import { EventEmitter2 } from '@nestjs/event-emitter';
import { Room } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { LeaderboardService } from '../src/realtime/leaderboard.service';
import { RoomGateway } from '../src/realtime/room.gateway';
import { REDIS } from '../src/redis/redis.module';
import { seedHouseRooms } from '../src/seed';
import { bootApp, flushRedis, joinWithRejoin, resetDb, urlOf } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The failure is a race (viewer cleanup landing behind QUIT on the shared
// connection), so one close proves little; a few rounds make a regression
// show up nearly every run.
describe('shutdown', () => {
  it.each([1, 2, 3, 4])(
    'closes cleanly with viewers connected and gifts just sent, round %i',
    async () => {
      const app = await bootApp();
      let closed = false;
      try {
        const prisma = app.get(PrismaService);
        await resetDb(prisma);
        await flushRedis(app.get(REDIS));
        await seedHouseRooms(prisma);
        const room: Room = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;

        const cookies: string[] = [];
        for (let i = 0; i < 5; i++) {
          const res = await request(app.getHttpServer()).get('/me').expect(200);
          cookies.push((res.headers['set-cookie'][0] as string).split(';')[0]);
        }
        const clients = await Promise.all(
          cookies.map(async (cookie) => {
            const c = await joinWithRejoin(urlOf(app), cookie, room.id);
            await c.waitFor('chat:history');
            return c;
          }),
        );
        await Promise.all(
          cookies.flatMap((cookie) =>
            [0, 1].map(() =>
              request(app.getHttpServer())
                .post(`/rooms/${room.id}/gifts`)
                .set('Cookie', cookie)
                .send({ giftId: 'tea', tapId: randomUUID() })
                .expect(200),
            ),
          ),
        );

        clients.forEach((c) => c.socket.close());
        closed = true;
        await expect(app.close()).resolves.toBeUndefined();
      } finally {
        // A setup failure must not leak a running app into the next round.
        if (!closed) await app.close();
      }
      // A late rejection from the closed app would be blamed on the next test.
      await sleep(1000);
    },
  );
});

describe('shutdown with a gift committed after the gateway stopped', () => {
  it('still counts the gift and closes without a Redis error', async () => {
    const app = await bootApp();
    const redis = app.get<Redis>(REDIS);
    const prisma = app.get(PrismaService);
    await resetDb(prisma);
    await flushRedis(redis);
    await seedHouseRooms(prisma);
    const room = (await prisma.room.findFirst({ where: { house: true, kind: 'VIDEO' } }))!;

    // Stands in for a request that was already inside the wallet when SIGTERM
    // came: its event fires once the gateway has finished its own shutdown
    // step, and its Redis work is still running when the sockets and the HTTP
    // server are done closing.
    const board = app.get(LeaderboardService);
    const add = board.add.bind(board);
    jest.spyOn(board, 'add').mockImplementation(async (...args) => {
      await sleep(200);
      return add(...args);
    });
    const gateway = app.get(RoomGateway);
    const stop = gateway.beforeApplicationShutdown.bind(gateway);
    jest.spyOn(gateway, 'beforeApplicationShutdown').mockImplementation(async () => {
      await stop();
      app.get(EventEmitter2).emit('gift.committed', {
        gift: { giftId: 'tea', coins: 10, createdAt: new Date() },
        guest: { name: 'late-guest' },
        room,
      });
    });

    await expect(app.close()).resolves.toBeUndefined();

    const check = new Redis(process.env.REDIS_URL_TEST!);
    try {
      expect(await check.zscore(`lb:${room.id}`, 'late-guest')).toBe('10');
    } finally {
      await check.quit();
    }
  });
});
