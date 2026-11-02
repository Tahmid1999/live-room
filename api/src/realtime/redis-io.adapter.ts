import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  // channelKey: pub/sub channels ignore the db number, so a test run on db 1
  // would otherwise hear a dev server on db 0.
  // Duplicates of the app connection: a subscribed connection cannot run
  // ordinary commands, so the adapter needs its own pair.
  constructor(
    app: INestApplicationContext,
    redis: Redis,
    private readonly origin: string | undefined,
    private readonly channelKey: string,
  ) {
    super(app);
    this.pub = redis.duplicate();
    this.sub = redis.duplicate();
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, {
      ...options,
      // Websocket only, so a reconnect can land on either replica without sticky sessions.
      transports: ['websocket'],
      // A chat line is at most a few hundred bytes; the 1 MB default would let
      // one client make the server parse a megabyte per message.
      maxHttpBufferSize: 8 * 1024,
      cors: { origin: this.origin, credentials: true },
    });
    server.adapter(createAdapter(this.pub, this.sub, { key: this.channelKey }));
    return server;
  }

  async close(server: Server) {
    await super.close(server);
    // quit, not disconnect: the adapter publishes without awaiting, and
    // disconnect would reject any publish still waiting for its reply as an
    // unhandled rejection.
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}
