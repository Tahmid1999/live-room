import { Engine, RoomKind } from '@prisma/client';

// Self-hosted egress grows with every viewer: video is too heavy for the box,
// audio is not. So video goes to Agora and audio to our own LiveKit.
export function engineFor(kind: RoomKind): Engine {
  return kind === 'VIDEO' ? 'agora' : 'livekit';
}
