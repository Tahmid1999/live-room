import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import Redis from 'ioredis';
import { EventsService } from '../events/events.service';
import { GuestGuard, GuestRequest } from '../guests/guests.guard';
import { hit } from '../limits';
import { REDIS } from '../redis/redis.module';
import { WalletService } from './wallet.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
@UseGuards(GuestGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly hood: EventsService,
  ) {}

  @Post('rooms/:id/gifts')
  @HttpCode(200)
  async send(
    @Param('id') roomId: string,
    @Body() body: { giftId?: unknown; tapId?: unknown },
    @Req() req: GuestRequest,
  ) {
    const guestId = req.guest.id;
    // The burst header swaps the per-second limit for one 20-tap allowance a
    // minute instead of adding to it.
    const allowed =
      req.headers['x-burst'] === '1'
        ? await hit(this.redis, `burst:${guestId}`, 20, 60)
        : await hit(this.redis, `gift:${guestId}`, 10, 1);
    if (!allowed) {
      this.hood.note('rate-limit', 'rate-limit gift');
      throw new HttpException({ error: 'slow down' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const { giftId, tapId } = body ?? {};
    if (typeof giftId !== 'string') throw new BadRequestException({ error: 'giftId is required' });
    if (typeof tapId !== 'string' || !UUID.test(tapId)) {
      throw new BadRequestException({ error: 'tapId must be a UUID' });
    }
    return this.wallet.sendGift({ guestId, roomId, giftId, tapId });
  }
}
