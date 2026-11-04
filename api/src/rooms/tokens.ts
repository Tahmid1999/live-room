import { AccessToken } from 'livekit-server-sdk';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function liveKitToken(
  room: string,
  identity: string,
  ttlSec: number,
  canPublish: boolean,
): Promise<string> {
  const token = new AccessToken(env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'), {
    identity,
    ttl: ttlSec,
  });
  token.addGrant({
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish,
    canPublishData: canPublish,
    // A viewer is invisible to the others: no participant list of guest ids
    // for anyone to read, and no join and leave events fanned out to 50 phones.
    hidden: !canPublish,
  });
  return token.toJwt();
}

export function mintLiveKitViewer(room: string, identity: string, ttlSec = 600): Promise<string> {
  return liveKitToken(room, identity, ttlSec, false);
}

export function mintLiveKitHost(room: string, identity: string, ttlSec = 600): Promise<string> {
  return liveKitToken(room, identity, ttlSec, true);
}
