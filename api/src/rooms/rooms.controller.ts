import {
  BadRequestException,
  CanActivate,
  Body,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { GuestGuard, GuestRequest } from '../guests/guests.guard';
import { RoomsService } from './rooms.service';

@Injectable()
export class HouseKeyGuard implements CanActivate {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = digest(config.getOrThrow('HOUSE_KEY'));
  }

  canActivate(context: ExecutionContext) {
    const sent = context.switchToHttp().getRequest<Request>().headers['x-house-key'];
    // Hashing both sides gives timingSafeEqual equal-length inputs, so the
    // length of the real key does not leak either.
    if (typeof sent !== 'string' || !timingSafeEqual(digest(sent), this.key)) {
      throw new UnauthorizedException({ error: 'bad house key' });
    }
    return true;
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

@Controller()
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('rooms')
  list() {
    return this.rooms.list();
  }

  @Post('rooms/:id/join')
  @HttpCode(200)
  @UseGuards(GuestGuard)
  join(@Param('id') id: string, @Req() req: GuestRequest) {
    return this.rooms.join(id, req.guest, req.ip ?? '');
  }

  @Post('house/token')
  @HttpCode(200)
  @UseGuards(HouseKeyGuard)
  houseToken(@Body() body: { roomId?: unknown }) {
    if (typeof body?.roomId !== 'string') {
      throw new BadRequestException({ error: 'roomId is required' });
    }
    return this.rooms.houseToken(body.roomId);
  }
}
