import { Controller, Get } from '@nestjs/common';
import { EgressService } from './egress.service';

@Controller('bandwidth')
export class EgressController {
  constructor(private readonly egress: EgressService) {}

  @Get()
  bandwidth() {
    return this.egress.bandwidth();
  }
}
