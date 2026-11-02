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
        // 200 retries at 25ms +-25 is about 5s of waiting. 50 gifts from one guest
        // queue on one lock (~1.4s to drain, 2s+ on a loaded machine), so a 2s
        // window failed intermittently; finite so a stuck holder still ends in
        // a clean ExecutionError.
        const redlock = new Redlock([redis], {
          retryCount: 200,
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
