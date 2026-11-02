import { Injectable } from '@nestjs/common';

// Work that is detached from a request or a socket message but still talks to
// Redis. RedisModule waits for it before quitting, because a command written
// behind QUIT can make the server drop the connection and lose the QUIT reply.
@Injectable()
export class Inflight {
  private readonly work = new Set<Promise<unknown>>();

  track(job: Promise<unknown>) {
    this.work.add(job);
    const done = () => this.work.delete(job);
    job.then(done, done);
  }

  async settled() {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
}
