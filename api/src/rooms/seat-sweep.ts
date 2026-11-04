import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { TransferBudget } from '../egress/transfer-budget';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma.service';
import { REDIS } from '../redis/redis.module';
import { hasJoined } from './joined';
import { LIVEKIT_ROOMS, LiveKitRooms } from './livekit-rooms';
import { HOUSE_IDENTITY } from './rooms.service';

// LiveKit keeps a connected participant for as long as it stays connected, and
// a token only matters at connect time. So the daily video limit and the
// monthly pause hold only if the API takes seats away itself: whoever has no
// current join proof (it lapses unless /renew is called, and renewals are
// capped per day) is removed, and while video is paused every guest seat goes,
// whoever has a proof. The client sees a disconnect and has to join again,
// which is where the limits are checked.
@Injectable()
export class SeatSweep {
  private readonly log = new Logger(SeatSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LIVEKIT_ROOMS) private readonly livekit: LiveKitRooms,
    private readonly budget: TransferBudget,
    private readonly hood: EventsService,
  ) {}

  async sweep(now: number): Promise<number> {
    // Audio costs next to nothing and has no limit to enforce.
    const rooms = await this.prisma.room.findMany({
      where: { status: 'LIVE', kind: 'VIDEO' },
      select: { id: true },
    });
    if (!rooms.length) return 0;
    const paused = await this.budget.isVideoPaused();
    let removed = 0;
    let firstError: unknown;
    // Listed together so a room that hangs costs the timeout once, not once
    // per room, and the next slot is not left waiting behind this one.
    const listings = await Promise.all(
      rooms.map(async ({ id }) => {
        try {
          return { id, seated: await this.livekit.participants(id) };
        } catch (err) {
          // One room's failure must not leave the others unswept.
          firstError ??= err;
          return null;
        }
      }),
    );
    for (const listing of listings) {
      if (!listing) continue;
      const { id, seated } = listing;
      for (const identity of seated) {
        if (identity === HOUSE_IDENTITY) continue;
        if (!paused && (await hasJoined(this.redis, id, identity, now))) continue;
        try {
          await this.livekit.remove(id, identity);
        } catch (err) {
          firstError ??= err;
          continue;
        }
        removed++;
        this.hood.note(
          'join-refused',
          paused ? 'seat removed · video paused' : 'seat removed · video time used',
        );
      }
    }
    // Once per tick, however many rooms failed: a node that is down would
    // otherwise write a line per room every 10 s.
    if (firstError) this.log.warn(`seat sweep failed: ${(firstError as Error).message}`);
    return removed;
  }
}
