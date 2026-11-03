import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { REDIS } from './redis/redis.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

// Shared by main.ts and the e2e bootApp() so tests see the same ip, cookie and socket handling.
export function configureApp(app: NestExpressApplication) {
  const config = app.get(ConfigService);
  // Caddy runs on the same host, so only a loopback peer may set X-Forwarded-For.
  // In compose the API sits behind Docker's port publishing, which shows Caddy
  // as the bridge gateway instead; TRUST_PROXY adds that one address.
  app.set('trust proxy', config.get('TRUST_PROXY') ?? 'loopback');
  app.use(cookieParser(config.getOrThrow('COOKIE_SECRET')));
  const channelKey = config.get('NODE_ENV') === 'test' ? 'lr-test' : 'lr';
  app.useWebSocketAdapter(
    new RedisIoAdapter(app, app.get<Redis>(REDIS), config.get('WEB_ORIGIN'), channelKey),
  );
}
