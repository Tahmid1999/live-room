import { Injectable } from '@nestjs/common';

export type HoodEvent = {
  t: number;
  kind:
    | 'gift'
    | 'gift-dup'
    | 'gift-rejected'
    | 'engine'
    | 'join-refused'
    | 'house'
    | 'settlement'
    | 'retention'
    | 'kill'
    | 'rate-limit';
  replica: string;
  text: string;
};

@Injectable()
export class EventsService {
  emit(e: HoodEvent): void {}
}
