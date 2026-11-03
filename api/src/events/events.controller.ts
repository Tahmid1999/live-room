import { Controller, Get, ServiceUnavailableException, Sse } from '@nestjs/common';
import { EventsService, MAX_STREAMS } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse('stream')
  stream() {
    if (this.events.openStreams >= MAX_STREAMS) {
      throw new ServiceUnavailableException({ error: 'too many open streams, try again soon' });
    }
    return this.events.stream();
  }

  @Get('recent')
  recent() {
    return this.events.recent();
  }
}
