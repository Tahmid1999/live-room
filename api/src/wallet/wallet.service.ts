import { ConflictException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redlock, { ExecutionError } from 'redlock';
import { PrismaService } from '../prisma.service';
import { REDLOCK } from '../redis/redis.module';
import { RoomsService } from '../rooms/rooms.service';
import { GIFTS } from './gifts';

export type GiftResult = {
  tapId: string;
  balance: number;
  coins: number;
  duplicate: boolean;
  lockMs: number;
  txMs: number;
};

const LOCK_TTL_MS = 2000;
// Shorter than the lock: a transaction that would outlive it is aborted
// instead of committing after another request has been let in.
const TX_TIMEOUT_MS = 1500;

@Injectable()
export class WalletService {
  private readonly hostSharePct: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDLOCK) private readonly redlock: Redlock,
    private readonly rooms: RoomsService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.hostSharePct = Number(config.getOrThrow('HOST_SHARE_PCT'));
  }

  async sendGift(input: {
    guestId: string;
    roomId: string;
    giftId: string;
    tapId: string;
  }): Promise<GiftResult> {
    const { guestId, tapId } = input;
    const def = GIFTS.find((g) => g.id === input.giftId);
    if (!def) throw new HttpException({ error: 'unknown gift' }, HttpStatus.BAD_REQUEST);
    const room = await this.rooms.liveRoom(input.roomId);
    // The host gets the floor and the platform the remainder, so the three
    // ledger entries sum to exactly 0 whatever the percentage.
    const hostAmount = Math.floor((def.coins * this.hostSharePct) / 100);

    // Redlock because Mongo has no row lock to lean on: it serialises one
    // guest across replicas, so the balance check and the decrement cannot
    // interleave. The unique tapId catches a retry that arrives after the
    // first request already committed.
    // Never update a shared per-room document in here; two guests gifting the
    // same room would collide as write conflicts.
    const lockStart = performance.now();
    const lock = await this.redlock.acquire([`wallet:${guestId}`], LOCK_TTL_MS).catch((err) => {
      if (err instanceof ExecutionError) {
        throw new HttpException({ error: 'busy, try again' }, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw err;
    });
    const lockMs = performance.now() - lockStart;

    const txStart = performance.now();
    let done;
    try {
      done = await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.gift.findUnique({ where: { tapId } });
          if (existing) {
            if (existing.guestId !== guestId) {
              throw new ConflictException({ error: 'tapId already used' });
            }
            const guest = await tx.guest.findUniqueOrThrow({ where: { id: guestId } });
            return { gift: existing, guest, duplicate: true };
          }

          const before = await tx.guest.findUniqueOrThrow({ where: { id: guestId } });
          if (before.balance < def.coins) {
            throw new HttpException({ error: 'not enough coins' }, HttpStatus.PAYMENT_REQUIRED);
          }
          const guest = await tx.guest.update({
            where: { id: guestId },
            data: { balance: { decrement: def.coins } },
          });
          const gift = await tx.gift.create({
            data: { tapId, roomId: room.id, guestId, giftId: def.id, coins: def.coins },
          });
          await tx.ledgerEntry.createMany({
            data: [
              { tapId, account: `guest:${guestId}`, amount: -def.coins },
              { tapId, account: `host:${room.id}`, amount: hostAmount },
              { tapId, account: 'platform', amount: def.coins - hostAmount },
            ],
          });
          await tx.hostEarning.create({ data: { tapId, roomId: room.id, amount: hostAmount } });
          return { gift, guest, duplicate: false };
        },
        { maxWait: LOCK_TTL_MS, timeout: TX_TIMEOUT_MS },
      );
    } finally {
      // A stalled request may find its lock already expired; that must not
      // replace the transaction outcome.
      await lock.release().catch(() => {});
    }
    const txMs = performance.now() - txStart;

    if (!done.duplicate) {
      this.events.emit('gift.committed', {
        gift: done.gift,
        guest: done.guest,
        room,
        lockMs,
        txMs,
      });
    }
    return {
      tapId,
      balance: done.guest.balance,
      coins: done.gift.coins,
      duplicate: done.duplicate,
      lockMs,
      txMs,
    };
  }
}
