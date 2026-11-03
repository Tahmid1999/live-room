import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { Clock, CLOCK } from '../clock';
import { roomEgress } from '../egress/reports';
import { EventsService } from '../events/events.service';
import { hashIp } from '../guests/guests.service';
import { UNSETTLED } from '../jobs/settlement.service';
import { hit } from '../limits';
import { viewerCount } from '../presence';
import { PrismaService } from '../prisma.service';
import { RoomGateway } from '../realtime/room.gateway';
import { REDIS } from '../redis/redis.module';
import { ADMIN_COOKIE, AdminAuth, AdminGuard, SESSION_SEC } from './admin.auth';

const LOGINS_PER_IP = 5;
const DEFAULT_GIFTS = 50;
const MAX_GIFTS = 200;
const OBJECT_ID = /^[0-9a-f]{24}$/;

@Controller('admin')
export class AdminController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly auth: AdminAuth,
    private readonly gateway: RoomGateway,
    private readonly hood: EventsService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow('COOKIE_SECRET');
  }

  @Get('rooms')
  async rooms() {
    const rooms = await this.prisma.room.findMany({ orderBy: { createdAt: 'asc' } });
    const now = this.clock.now();
    return Promise.all(
      rooms.map(async (r) => {
        const egress = await roomEgress(this.redis, r.id, now);
        return {
          id: r.id,
          kind: r.kind,
          engine: r.engine,
          title: r.title,
          hostName: r.hostName,
          house: r.house,
          status: r.status,
          viewers: await viewerCount(this.redis, r.id, now),
          perViewerBps: egress.perViewerBps,
          totalBps: egress.totalBps,
          ageSec: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 1000)),
        };
      }),
    );
  }

  @Get('gifts')
  async gifts(@Query('limit') limit?: string) {
    const take = Math.min(MAX_GIFTS, Math.max(1, Number.parseInt(limit ?? '', 10) || DEFAULT_GIFTS));
    const gifts = await this.prisma.gift.findMany({ orderBy: { createdAt: 'desc' }, take });
    const [guests, rooms] = await Promise.all([
      this.prisma.guest.findMany({
        where: { id: { in: [...new Set(gifts.map((g) => g.guestId))] } },
        select: { id: true, name: true },
      }),
      this.prisma.room.findMany({
        where: { id: { in: [...new Set(gifts.map((g) => g.roomId))] } },
        select: { id: true, title: true },
      }),
    ]);
    const guestName = new Map(guests.map((g) => [g.id, g.name]));
    const roomTitle = new Map(rooms.map((r) => [r.id, r.title]));
    return gifts.map((g) => ({
      at: g.createdAt.getTime(),
      // Guests are purged 25 h after they arrive and a gift lives 24 h after
      // it is sent, so a gift often outlives its guest.
      guest: guestName.get(g.guestId) ?? 'expired guest',
      room: roomTitle.get(g.roomId)!,
      giftId: g.giftId,
      coins: g.coins,
    }));
  }

  @Get('wallets')
  async wallets() {
    const now = new Date(this.clock.now());
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [balances, ledger, giftsToday] = await Promise.all([
      this.prisma.guest.aggregate({ _sum: { balance: true } }),
      this.prisma.ledgerEntry.aggregate({ _sum: { amount: true } }),
      this.prisma.gift.count({ where: { createdAt: { gte: midnight } } }),
    ]);
    // _sum is null over zero rows.
    return {
      coinsInCirculation: balances._sum.balance ?? 0,
      ledgerSum: ledger._sum.amount ?? 0,
      giftsToday,
    };
  }

  @Get('payouts')
  async payouts() {
    const [unsettled, runs, payouts] = await Promise.all([
      this.prisma.hostEarning.aggregate({ where: UNSETTLED, _sum: { amount: true } }),
      this.prisma.settlementRun.findMany({ orderBy: { finishedAt: 'desc' }, take: 20 }),
      this.prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { earningsUnsettled: unsettled._sum.amount ?? 0, runs, payouts };
  }

  @Get('me')
  me(@Req() req: Request) {
    return { admin: this.auth.verify(req.cookies?.[ADMIN_COOKIE]) };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { password?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Counted before the password is looked at, so guessing costs the same
    // whether or not a guess is right.
    const ipHash = hashIp(req.ip ?? '', this.secret);
    if (!(await hit(this.redis, `adminlogin:${ipHash}`, LOGINS_PER_IP, 3600))) {
      this.hood.note('rate-limit', 'rate-limit admin login');
      throw new HttpException(
        { error: 'too many login attempts, try in an hour' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (typeof body?.password !== 'string') {
      throw new BadRequestException({ error: 'password is required' });
    }
    if (!this.auth.passwordMatches(body.password)) {
      throw new UnauthorizedException({ error: 'wrong password' });
    }
    res.cookie(ADMIN_COOKIE, this.auth.sign(), {
      httpOnly: true,
      // Strict is what keeps the kill POST from being sent by another site.
      sameSite: 'strict',
      secure: req.secure,
      maxAge: SESSION_SEC * 1000,
    });
    return { admin: true };
  }

  @Post('rooms/:id/kill')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async kill(@Param('id') id: string) {
    if (!OBJECT_ID.test(id)) throw new NotFoundException({ error: 'no such room' });
    // One conditional write decides who killed it, so two admins clicking at
    // once produce one event, not two.
    const { count } = await this.prisma.room.updateMany({
      where: { id, status: { not: 'KILLED' } },
      data: { status: 'KILLED' },
    });
    if (count === 0) {
      if (!(await this.prisma.room.findUnique({ where: { id } }))) {
        throw new NotFoundException({ error: 'no such room' });
      }
      return { id, status: 'KILLED' };
    }
    const room = await this.prisma.room.findUniqueOrThrow({ where: { id } });
    this.gateway.closeRoom(id);
    this.hood.note('kill', `kill ${room.kind.toLowerCase()} room`);
    return { id, status: 'KILLED' };
  }
}
