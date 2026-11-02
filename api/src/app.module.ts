import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { GuestsModule } from './guests/guests.module';
import { PrismaModule } from './prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, GuestsModule],
  controllers: [HealthController],
})
export class AppModule {}
