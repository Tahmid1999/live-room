import { Global, Module } from '@nestjs/common';

export const CLOCK = Symbol('CLOCK');

export type Clock = { now(): number };

// Presence, join refusal and egress read time from here so tests can move it.
@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: { now: () => Date.now() } satisfies Clock }],
  exports: [CLOCK],
})
export class ClockModule {}
