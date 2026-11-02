import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SettlementRun } from '@prisma/client';
import Redlock from 'redlock';
import { Clock, CLOCK } from '../clock';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma.service';
import { REDLOCK } from '../redis/redis.module';
import { REPLICA } from '../replica';
import { runLocked } from './run-locked';

const BATCH = 500;
// Well under the lock TTL, so a transaction that outlives the lock is aborted
// by Prisma before another replica could start the same work.
const TX_TIMEOUT_MS = 30_000;

// Prisma on Mongo leaves an omitted optional field out of the document, and
// `{ settledRunId: null }` does not match a missing field, so the earnings
// WalletService creates would never be picked up by the null filter alone.
export const UNSETTLED = {
  OR: [{ settledRunId: null }, { settledRunId: { isSet: false } }],
};

@Injectable()
export class SettlementService {
  // Test seam: runs after payouts and marking, so a throw proves all of it rolls back.
  afterPayouts?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDLOCK) private readonly redlock: Redlock,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPLICA) private readonly replica: string,
    private readonly events: EventsService,
  ) {}

  @Cron('*/10 * * * *')
  async runOnce(): Promise<SettlementRun | null> {
    return runLocked(this.redlock, 'job:settlement', () => this.settle());
  }

  private async settle(): Promise<SettlementRun | null> {
    const t0 = performance.now();
    const startedAt = new Date(this.clock.now());

    const done = await this.prisma.$transaction(
      async (tx) => {
        const earnings = await tx.hostEarning.findMany({
          where: UNSETTLED,
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        });
        if (earnings.length === 0) return null;

        const perRoom = new Map<string, number>();
        for (const e of earnings) {
          perRoom.set(e.roomId, (perRoom.get(e.roomId) ?? 0) + e.amount);
        }
        const total = earnings.reduce((sum, e) => sum + e.amount, 0);

        const run = await tx.settlementRun.create({
          data: {
            replica: this.replica,
            startedAt,
            finishedAt: startedAt,
            rows: earnings.length,
            total,
          },
        });
        await tx.payout.createMany({
          data: [...perRoom].map(([roomId, amount]) => ({ runId: run.id, roomId, amount })),
        });
        // Mongo's snapshot and write-conflict detection is what stops a second
        // writer after a lost lock; filtering on UNSETTLED again and checking
        // the count is defence in depth.
        const marked = await tx.hostEarning.updateMany({
          where: { id: { in: earnings.map((e) => e.id) }, ...UNSETTLED },
          data: { settledRunId: run.id },
        });
        if (marked.count !== earnings.length) {
          throw new Error(`settled ${marked.count} of ${earnings.length} earnings`);
        }
        this.afterPayouts?.();

        const finished = await tx.settlementRun.update({
          where: { id: run.id },
          data: { finishedAt: new Date(this.clock.now()) },
        });
        return { run: finished, rooms: perRoom.size };
      },
      { timeout: TX_TIMEOUT_MS },
    );
    if (!done) return null;

    const ms = Math.round(performance.now() - t0);
    this.events.emit({
      t: this.clock.now(),
      kind: 'settlement',
      replica: this.replica,
      text: `settlement · ${done.rooms} rooms · ${done.run.rows} earnings · ${done.run.total} coins · ${ms} ms · ${this.replica}`,
    });
    return done.run;
  }
}
