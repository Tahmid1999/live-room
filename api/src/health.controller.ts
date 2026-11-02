import { Controller, Get, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from './prisma.service';
import { REDIS } from './redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check() {
    await this.prisma.$runCommandRaw({ ping: 1 });
    await this.redis.ping();
    return { mongo: 'ok', redis: 'ok' };
  }
}
