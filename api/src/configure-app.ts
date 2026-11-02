import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

// Shared by main.ts and the e2e bootApp() so tests see the same ip and cookie handling.
export function configureApp(app: NestExpressApplication) {
  // Caddy runs on the same host, so only a loopback peer may set X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
}
