import type { Socket } from 'socket.io-client';

// Reports from the moment the room is joined, 0 until a track plays: the
// server counts a viewer as present from these reports, so they must not wait
// for the stream.
export function startStats(socket: Socket, bitrate: () => number): () => void {
  const timer = setInterval(() => {
    if (socket.connected) socket.emit('stats', { bps: bitrate() });
  }, 5000);
  return () => clearInterval(timer);
}
