import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
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
