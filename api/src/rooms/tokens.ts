import { createHash } from 'node:crypto';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { AccessToken } from 'livekit-server-sdk';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// 31 bits so the uid stays a positive int everywhere; 0 means "any uid" to
// Agora and 1 is the house host.
export function agoraUidFor(guestId: string): number {
  const n = createHash('sha256').update(guestId).digest().readUInt32BE(0) & 0x7fffffff;
  return n < 2 ? n + 2 : n;
}

// Agora expiry arguments are seconds from now, not a timestamp. The privilege
// expiry is passed explicitly too: left at 0 it is not guaranteed to follow the token.
function agoraToken(channel: string, uid: number, role: number, ttlSec: number) {
  return RtcTokenBuilder.buildTokenWithUid(
    env('AGORA_APP_ID'),
    env('AGORA_APP_CERT'),
    channel,
    uid,
    role,
    ttlSec,
    ttlSec,
  );
}

// Agora only enforces the subscriber role once co-host authentication is
// switched on for the project; without it this token can still publish.
export function mintAgoraViewer(channel: string, uid: number, ttlSec = 600): string {
  return agoraToken(channel, uid, RtcRole.SUBSCRIBER, ttlSec);
}

export function mintAgoraHost(channel: string, uid: number, ttlSec = 600): string {
  return agoraToken(channel, uid, RtcRole.PUBLISHER, ttlSec);
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
