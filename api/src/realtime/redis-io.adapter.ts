import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  // Duplicates of the app connection: a subscribed connection cannot run
  // ordinary commands, so the adapter needs its own pair.
  constructor(
    app: INestApplicationContext,
    redis: Redis,
    private readonly origin: string | undefined,
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
      cors: { origin: this.origin, credentials: true },
    });
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  async close(server: Server) {
    await super.close(server);
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
