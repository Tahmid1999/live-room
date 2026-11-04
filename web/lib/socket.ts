import { io, Socket } from 'socket.io-client';

// The API's host, in dev and in production alike: the Next rewrite only
// forwards HTTP. Unset means the page's own origin. socket.io-client treats ''
// as a host name and builds "https://", so the fallback is undefined, not ''.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL?.replace(/\/+$/, '') || undefined;

export function openRoomSocket(roomId: string): Socket {
  const socket = io(SOCKET_URL, { transports: ['websocket'], withCredentials: true });
  // On every connect, not once: rooms live on the server process that held the
  // socket, so a reconnect that lands elsewhere has to ask for the room again.
  socket.on('connect', () => socket.emit('room:join', { roomId }));
  return socket;
}
