import { io, Socket } from 'socket.io-client';

// Unset (or empty) means the page's own origin, which is how production runs
// behind one proxy. socket.io-client treats '' as a host name and builds
// "https://", so the fallback has to be undefined, not an empty string.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;

export function openRoomSocket(roomId: string): Socket {
  const socket = io(SOCKET_URL, { transports: ['websocket'], withCredentials: true });
  // On every connect, not once: rooms live on the server process that held the
  // socket, so a reconnect that lands elsewhere has to ask for the room again.
  socket.on('connect', () => socket.emit('room:join', { roomId }));
  return socket;
}
