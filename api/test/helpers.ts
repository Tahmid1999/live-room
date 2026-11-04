import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma.service';
import { READ_CACHE_MS } from '../src/read-cache';
import { REPLICA } from '../src/replica';
import { LIVEKIT_ROOMS, LiveKitRooms } from '../src/rooms/livekit-rooms';

// LiveKit's room API is a stand-in that holds nobody unless a test passes its
// own, so no test depends on a node running.
const emptyNode: LiveKitRooms = { participants: async () => [], remove: async () => {} };

// Each call builds an independent app, so two replicas can run in one process.
// The read cache is off unless asked for: most tests change data and read it
// back within the same second.
export async function bootApp(
  opts: { replica?: string; readCacheMs?: number; livekitRooms?: LiveKitRooms } = {},
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.replica) builder.overrideProvider(REPLICA).useValue(opts.replica);
  builder.overrideProvider(LIVEKIT_ROOMS).useValue(opts.livekitRooms ?? emptyNode);
  builder.overrideProvider(READ_CACHE_MS).useValue(opts.readCacheMs ?? 0);
  const moduleRef = await builder.compile();
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
    // A browser always sends its page's origin; the handshake refuses any other.
    extraHeaders: { cookie, origin: process.env.WEB_ORIGIN! },
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
// The socket only admits guests who came through POST /join. Tests that are
// about something else mark the guest as joined without spending the per-network
// join allowance, which a 50-way test would blow through.
export async function allowJoin(cookie: string, roomId: string) {
  const signed = decodeURIComponent(cookie.split('=')[1]);
  const guestId = signed.slice(2, signed.lastIndexOf('.'));
  const redis = new Redis(process.env.REDIS_URL_TEST!);
  // Never lapses on the injected clock, whatever a test sets it to.
  await redis.set(`joined:${roomId}:${guestId}`, String(Number.MAX_SAFE_INTEGER), 'PX', 600_000);
  await redis.quit();
}

export async function joinWithRejoin(url: string, cookie: string, roomId: string) {
  await allowJoin(cookie, roomId);
  const client = await connectClient(url, cookie);
  client.socket.on('connect', () => client.socket.emit('room:join', { roomId }));
  return client;
}
