import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Clock, CLOCK } from '../clock';

export const ADMIN_COOKIE = 'lr_admin';
export const SESSION_SEC = 12 * 3600;

// The header is fixed and compared as text, so a token that names any other
// algorithm (including "none") fails before its signature is looked at.
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

@Injectable()
export class AdminAuth {
  private readonly password: Buffer;
  private readonly key: Buffer;

  constructor(
    config: ConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    const password = config.getOrThrow<string>('ADMIN_PASSWORD');
    this.password = digest(password);
    // Folding the password in means changing it signs every open session out.
    this.key = createHmac('sha256', config.getOrThrow('COOKIE_SECRET'))
      .update(`admin-jwt:${password}`)
      .digest();
  }

  passwordMatches(sent: string): boolean {
    // Hashing both sides gives timingSafeEqual equal-length inputs, so the
    // length of the real password does not leak either.
    return timingSafeEqual(digest(sent), this.password);
  }

  sign(): string {
    const iat = Math.floor(this.clock.now() / 1000);
    const claims = { sub: 'admin', iat, exp: iat + SESSION_SEC };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${HEADER}.${body}.${this.mac(`${HEADER}.${body}`)}`;
  }

  verify(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const [header, body, sig, extra] = token.split('.');
    if (header !== HEADER || !body || !sig || extra !== undefined) return false;
    const expected = Buffer.from(this.mac(`${header}.${body}`));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
      return typeof exp === 'number' && exp * 1000 > this.clock.now();
    } catch {
      return false;
    }
  }

  private mac(data: string) {
    return createHmac('sha256', this.key).update(data).digest('base64url');
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuth) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.auth.verify(req.cookies?.[ADMIN_COOKIE])) {
      throw new UnauthorizedException({ error: 'admin login required' });
    }
    return true;
  }
}
