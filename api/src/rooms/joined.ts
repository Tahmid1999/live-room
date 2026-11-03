import Redis from 'ioredis';

export const JOINED_MS = 15 * 60 * 1000;

const keyOf = (roomId: string, guestId: string) => `joined:${roomId}:${guestId}`;

// Proof that this guest got through POST /join (50-viewer cap, per-network
// allowance, Agora pause) for this room. The socket and /renew both ask for it,
// so neither is a way around those checks. The value is when it lapses, read
// against the injected clock like presence; the Redis TTL only cleans up.
export async function markJoined(redis: Redis, roomId: string, guestId: string, now: number) {
  await redis.set(keyOf(roomId, guestId), String(now + JOINED_MS), 'PX', JOINED_MS);
}

export async function hasJoined(redis: Redis, roomId: string, guestId: string, now: number) {
  const until = await redis.get(keyOf(roomId, guestId));
  return until !== null && Number(until) > now;
}
