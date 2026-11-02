import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SettlementRun } from '@prisma/client';
import Redlock, { ExecutionError } from 'redlock';
import { Clock, CLOCK } from '../clock';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma.service';
import { REDLOCK } from '../redis/redis.module';
import { REPLICA } from '../replica';

const BATCH = 500;
const LOCK_TTL_MS = 60_000;
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
  // Test seam: runs after the payouts are written, before earnings are marked.
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
    // retryCount 0: the global setting waits ~5 s and would then run anyway,
    // so the losing replica would settle right after the winner.
    const lock = await this.redlock
      .acquire(['job:settlement'], LOCK_TTL_MS, { retryCount: 0 })
      .catch((err) => {
        if (err instanceof ExecutionError) return null;
        throw err;
      });
    if (!lock) return null;
    try {
      return await this.settle();
    } finally {
      await lock.release().catch(() => {});
    }
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
            finishedAt: new Date(this.clock.now()),
            rows: earnings.length,
            total,
          },
        });
        await tx.payout.createMany({
          data: [...perRoom].map(([roomId, amount]) => ({ runId: run.id, roomId, amount })),
        });
        this.afterPayouts?.();

        // Filtering on UNSETTLED again means a writer that got past a lost
        // lock still cannot settle the same earning twice.
        const marked = await tx.hostEarning.updateMany({
          where: { id: { in: earnings.map((e) => e.id) }, ...UNSETTLED },
          data: { settledRunId: run.id },
        });
        if (marked.count !== earnings.length) {
          throw new Error(`settled ${marked.count} of ${earnings.length} earnings`);
        }
        return { run, rooms: perRoom.size };
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
