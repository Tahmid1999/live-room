import { Injectable } from '@nestjs/common';

@Injectable()
export class AgoraMinutes {
  // Always open until the minute counter exists.
  async isAgoraPaused(): Promise<boolean> {
    return false;
  }
}
