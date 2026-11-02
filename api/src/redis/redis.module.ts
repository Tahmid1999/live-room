import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import Redlock from 'redlock';

export const REDIS = Symbol('REDIS');
export const REDLOCK = Symbol('REDLOCK');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get('NODE_ENV') === 'test' ? 'REDIS_URL_TEST' : 'REDIS_URL';
        return new Redis(config.getOrThrow(key));
      },
    },
    {
      provide: REDLOCK,
      inject: [REDIS],
      useFactory: (redis: Redis) => {
        // 80 retries at 25ms +-25 is about 2s of waiting, matching the 2000 ms
        // wallet-lock acquire; finite so a stuck holder ends in a clean ExecutionError.
        const redlock = new Redlock([redis], {
          retryCount: 80,
          retryDelay: 25,
          retryJitter: 25,
        });
        // redlock emits 'error' on every contended attempt; with no listener
        // EventEmitter would throw. Real failures still reach callers via acquire().
        redlock.on('error', () => {});
        return redlock;
      },
    },
  ],
  exports: [REDIS, REDLOCK],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
