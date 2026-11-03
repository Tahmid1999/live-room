import { Controller, Get } from '@nestjs/common';
import { ReadCache } from '../read-cache';
import { EgressService } from './egress.service';

@Controller('bandwidth')
export class EgressController {
  constructor(
    private readonly egress: EgressService,
    private readonly cache: ReadCache,
  ) {}

  @Get()
  bandwidth() {
    return this.cache.get('bandwidth', () => this.egress.bandwidth());
  }
}
