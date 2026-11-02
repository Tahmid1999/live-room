import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redlock from 'redlock';
import { Clock, CLOCK } from '../clock';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma.service';
import { REDLOCK } from '../redis/redis.module';
import { REPLICA } from '../replica';
import { runLocked } from './run-locked';
import { UNSETTLED } from './settlement.service';

const MAX_AGE_MS = 24 * 3600 * 1000;
const BATCH = 500;

export type RetentionResult = { gifts: number; entries: number; coins: number };

@Injectable()
export class RetentionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDLOCK) private readonly redlock: Redlock,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPLICA) private readonly replica: string,
    private readonly events: EventsService,
  ) {}

  @Cron('0 * * * *')
  async runOnce(): Promise<RetentionResult | null> {
    return runLocked(this.redlock, 'job:retention', () => this.roll());
  }

  private async roll(): Promise<RetentionResult> {
    const t0 = performance.now();
    const cutoff = new Date(this.clock.now() - MAX_AGE_MS);

    // A group whose earning is not settled yet has to survive: the payout
    // still needs its HostEarning row. Excluding them in the query (and not
    // skipping them after the fetch) keeps the batch loop from re-reading the
    // same kept rows forever.
    const pending = await this.prisma.hostEarning.findMany({
      where: UNSETTLED,
      select: { tapId: true },
    });
    const keep = pending.map((p) => p.tapId);

    const result: RetentionResult = { gifts: 0, entries: 0, coins: 0 };
    for (;;) {
      const gifts = await this.prisma.gift.findMany({
        where: { createdAt: { lt: cutoff }, tapId: { notIn: keep } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      if (gifts.length === 0) break;

      const perDay = new Map<string, { gifts: number; coins: number }>();
      for (const g of gifts) {
        const day = g.createdAt.toISOString().slice(0, 10);
        const stat = perDay.get(day) ?? { gifts: 0, coins: 0 };
        stat.gifts += 1;
        stat.coins += g.coins;
        perDay.set(day, stat);
      }
      const tapIds = gifts.map((g) => g.tapId);

      // Counts and deletes commit together, so a crash cannot double-count a
      // batch on the next run or lose it.
      const entries = await this.prisma.$transaction(async (tx) => {
        for (const [day, s] of perDay) {
          await tx.dailyStat.upsert({
            where: { day },
            create: { day, gifts: s.gifts, coins: s.coins },
            update: { gifts: { increment: s.gifts }, coins: { increment: s.coins } },
          });
        }
        const removed = await tx.ledgerEntry.deleteMany({ where: { tapId: { in: tapIds } } });
        await tx.hostEarning.deleteMany({ where: { tapId: { in: tapIds } } });
        // Counted first by the stats above; if another run already took any of
        // these gifts the stats would be double-counted, so roll back instead.
        const deleted = await tx.gift.deleteMany({ where: { tapId: { in: tapIds } } });
        if (deleted.count !== gifts.length) {
          throw new Error(`deleted ${deleted.count} of ${gifts.length} gifts`);
        }
        return removed.count;
      });

      result.gifts += gifts.length;
      result.entries += entries;
      result.coins += gifts.reduce((sum, g) => sum + g.coins, 0);
    }

    if (result.gifts > 0) {
      const ms = Math.round(performance.now() - t0);
      this.events.emit({
        t: this.clock.now(),
        kind: 'retention',
        replica: this.replica,
        text: `retention · ${result.gifts} gifts · ${result.entries} entries · ${result.coins} coins · ${ms} ms · ${this.replica}`,
      });
    }
    return result;
  }
}
