import { RoomServiceClient } from 'livekit-server-sdk';

export const LIVEKIT_ROOMS = Symbol('LIVEKIT_ROOMS');

export type LiveKitRooms = {
  participants(room: string): Promise<string[]>;
  remove(room: string, identity: string): Promise<void>;
};

const NOT_FOUND = 404;
const TIMEOUT_SEC = 3;

export function liveKitRooms(url: string, apiKey: string, apiSecret: string): LiveKitRooms {
  const client = new RoomServiceClient(url, apiKey, apiSecret, {
    // The sweep runs inside the sampler's slot, so a node that stops answering
    // must cost seconds, not the default.
    requestTimeout: TIMEOUT_SEC,
  });
  return {
    // Viewer tokens are hidden: true, so the sweep only works if
    // ListParticipants returns hidden participants. It does, on livekit-server
    // 1.13.11: pkg/service/roomservice.go ListParticipants answers straight
    // from the room store with no hidden filter, and I confirmed it on the real
    // binary on a local node: one visible and one hidden participant
    // joined over the signal socket, both came back, and RemoveParticipant
    // dropped the hidden one. A room the node does not know gives [].
    async participants(room) {
      const list = await client.listParticipants(room);
      return list.map((p) => p.identity);
    },
    async remove(room, identity) {
      try {
        await client.removeParticipant(room, identity);
      } catch (err) {
        // Gone between the list and the remove is the outcome we wanted.
        if ((err as { status?: number }).status !== NOT_FOUND) throw err;
      }
    },
  };
}
