import { Controller, Get, Sse } from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse('stream')
  stream() {
    return this.events.stream();
  }

  @Get('recent')
  recent() {
    return this.events.recent();
  }
}
