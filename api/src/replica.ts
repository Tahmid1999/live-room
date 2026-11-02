import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const REPLICA = Symbol('REPLICA');

// || and not ??: a copied .env.example leaves REPLICA_NAME as an empty string.
@Global()
@Module({
  providers: [
    {
      provide: REPLICA,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<string>('REPLICA_NAME') || 'api-1',
    },
  ],
  exports: [REPLICA],
})
export class ReplicaModule {}
