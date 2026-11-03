import { Engine } from '@prisma/client';
import Redis from 'ioredis';
import { markPresent, PRESENT_MS } from '../presence';

// A viewer who stops reporting leaves a field behind; the key lapses a minute
// after the room's last report so an ended room does not keep its hash.
const HASH_TTL_SEC = 60;

// Every report is also the viewer's heartbeat, which is why presence is
// refreshed here and a phone that goes quiet drops out after 15 s.
export async function recordReport(
  redis: Redis,
  roomId: string,
  engine: Engine,
  guestId: string,
  bps: number,
  now: number,
) {
  await markPresent(redis, roomId, guestId, now);
  const key = `eg:${roomId}`;
  const write = redis.multi().hset(key, guestId, `${bps}|${now}`).expire(key, HASH_TTL_SEC);
  // A viewer still waiting for the stream reports 0. That is not what one
  // viewer costs, and it must not replace the last real measurement.
  if (bps > 0) write.set(`eg:last:${engine}`, `${bps}|${now}`);
  await write.exec();
}

// Read-only: it backs the public /bandwidth, which must not write.
export async function roomEgress(redis: Redis, roomId: string, now: number) {
  const reports = await redis.hgetall(`eg:${roomId}`);
  let viewers = 0;
  let receiving = 0;
  let totalBps = 0;
  for (const value of Object.values(reports)) {
    const [bps, at] = value.split('|').map(Number);
    if (now - at < PRESENT_MS) {
      viewers += 1;
      if (bps > 0) receiving += 1;
      totalBps += bps;
    }
  }
  // Over the viewers receiving something, like /bandwidth: a phone still
  // waiting for the stream reports 0 and would dilute the figure.
  return { viewers, receiving, perViewerBps: receiving ? totalBps / receiving : 0, totalBps };
}

// In Lua so a report that lands between the read and the delete is not lost.
const PRUNE = `
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local at = tonumber(string.match(all[i + 1], '|(%d+)$'))
  if at == nil or at <= tonumber(ARGV[1]) then redis.call('HDEL', KEYS[1], all[i]) end
end
`;

// Only the sampler calls this: it visits every live room every 10 s, so the
// hash cannot grow with the guests a busy room has had.
export async function pruneReports(redis: Redis, roomId: string, now: number) {
  await redis.eval(PRUNE, 1, `eg:${roomId}`, now - PRESENT_MS);
}
