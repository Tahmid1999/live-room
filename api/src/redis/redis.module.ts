import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import Redlock from 'redlock';
import { Inflight } from './inflight';

export const REDIS = Symbol('REDIS');
export const REDLOCK = Symbol('REDLOCK');

@Global()
@Module({
  providers: [
    Inflight,
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
  exports: [REDIS, REDLOCK, Inflight],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly inflight: Inflight,
  ) {}

  // Not onModuleDestroy: Nest runs destroy hooks before it closes the socket
  // server, and every socket that closes afterwards sends a ZREM for its
  // viewer entry. Commands written behind QUIT make the server drop the
  // connection with unread input, which can discard the QUIT reply, so quit()
  // rejects with "Connection is closed". Shutdown hooks run after the socket
  // server and the HTTP server are gone. Detached work that started during
  // that window (a gift whose request was already inside the wallet) is
  // awaited here, in the one place that is guaranteed to run before the quit;
  // the order of shutdown hooks between modules is not something to lean on.
  async onApplicationShutdown() {
    await this.inflight.settled();
    await this.redis.quit();
  }
}
