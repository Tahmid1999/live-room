import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma.service';

// Each call builds an independent app, so two replicas can run in one process.
export async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

export function urlOf(app: INestApplication): string {
  const { port } = app.getHttpServer().address();
  return `http://127.0.0.1:${port}`;
}

export async function resetDb(prisma: PrismaService) {
  await prisma.$transaction([
    prisma.payout.deleteMany(),
    prisma.settlementRun.deleteMany(),
    prisma.hostEarning.deleteMany(),
    prisma.ledgerEntry.deleteMany(),
    prisma.gift.deleteMany(),
    prisma.dailyStat.deleteMany(),
    prisma.room.deleteMany(),
    prisma.guest.deleteMany(),
  ]);
}

export async function flushRedis(redis: Redis) {
  // FLUSHDB, not FLUSHALL: the test db is /1 and /0 may hold dev data
  await redis.flushdb();
}

export type Client = {
  socket: Socket;
  count(event: string): number;
  // Resolves with the nth payload of an event, however long ago it arrived.
  waitFor(event: string, nth?: number, ms?: number): Promise<any>;
  moveTo(url: string): void;
};

export async function connectClient(url: string, cookie: string): Promise<Client> {
  const socket = io(url, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    reconnectionDelay: 100,
    reconnectionDelayMax: 200,
  });
  const log: { event: string; payload: unknown }[] = [];
  socket.onAny((event, payload) => log.push({ event, payload }));
  // onAny does not see the socket's own lifecycle events
  socket.on('connect_error', (err) => log.push({ event: 'connect_error', payload: err.message }));
  socket.on('disconnect', (reason) => log.push({ event: 'disconnect', payload: reason }));
  const of = (event: string) => log.filter((l) => l.event === event);
  return {
    socket,
    count: (event) => of(event).length,
    async waitFor(event, nth = 1, ms = 3000) {
      const deadline = Date.now() + ms;
      while (of(event).length < nth) {
        if (Date.now() > deadline) throw new Error(`no ${event} #${nth} within ${ms} ms`);
        await new Promise((r) => setTimeout(r, 15));
      }
      return of(event)[nth - 1].payload;
    },
    // A socket.io Manager keeps its target in a private field; reconnect attempts read it.
    moveTo(next) {
      (socket.io as unknown as { uri: string }).uri = next;
    },
  };
}

// The rejoin rule the web client copies: rooms live on the server that held
// the socket, so every (re)connect must ask for the room again.
export async function joinWithRejoin(url: string, cookie: string, roomId: string) {
  const client = await connectClient(url, cookie);
  client.socket.on('connect', () => client.socket.emit('room:join', { roomId }));
  return client;
}
