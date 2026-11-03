import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Guest } from '@prisma/client';
import { Request } from 'express';
import { GUEST_COOKIE, GuestsService } from './guests.service';

export interface GuestRequest extends Request {
  guest: Guest;
}

@Injectable()
export class GuestGuard implements CanActivate {
  constructor(
    private readonly guests: GuestsService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<GuestRequest>();
    let guest = await this.guests.fromCookieHeader(req.headers.cookie);
    if (!guest) {
      guest = await this.guests.create(req.ip ?? '');
      http.getResponse().cookie(GUEST_COOKIE, guest.id, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        // req.secure alone depends on the proxy settings being right; in
        // production the site is only ever served over TLS anyway.
        secure: req.secure || this.config.get('NODE_ENV') === 'production',
        maxAge: 24 * 3600 * 1000,
      });
    }
    req.guest = guest;
    return true;
  }
}
