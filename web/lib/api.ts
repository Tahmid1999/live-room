export type Me = { id: string; name: string; balance: number };

export type RoomCard = {
  id: string;
  kind: 'VIDEO' | 'AUDIO';
  engine: 'agora' | 'livekit';
  title: string;
  hostName: string;
  house: boolean;
  viewers: number;
  startsOnOpen: boolean;
};

export type JoinInfo =
  | { engine: 'agora'; appId: string; channel: string; uid: number; token: string }
  | { engine: 'livekit'; url: string; room: string; identity: string; token: string };

export type RateSource = { bps: number; source: 'live' | 'last'; at: number };

export type Bandwidth = {
  series: {
    t: number;
    livekitBps: number | null;
    wouldBeVideoBps: number;
    audioReportedBps: number;
  }[];
  projection: { perViewer: { agora?: RateSource; livekit?: RateSource } };
};

// Same ids and prices as api/src/wallet/gifts.ts. The server prices every tap
// itself, so a stale copy here can only mislabel a button.
export const GIFTS = [
  { id: 'tea', name: 'Tea', coins: 10 },
  { id: 'rose', name: 'Rose', coins: 50 },
  { id: 'clap', name: 'Clap', coins: 100 },
  { id: 'star', name: 'Star', coins: 300 },
  { id: 'crown', name: 'Crown', coins: 500 },
] as const;

export type GiftId = (typeof GIFTS)[number]['id'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export const getMe = () => call<Me>('/me');
export const getRooms = () => call<RoomCard[]>('/rooms');
export const getBandwidth = () => call<Bandwidth>('/bandwidth');
export const joinRoom = (roomId: string) =>
  call<JoinInfo>(`/rooms/${roomId}/join`, { method: 'POST' });

export type GiftResult =
  | { ok: true; balance: number }
  | { ok: false; status: number; error: string };

// Refusals are results, not exceptions: Send x20 tallies them by reason.
export async function sendGift(roomId: string, giftId: GiftId, burst = false): Promise<GiftResult> {
  try {
    const res = await call<{ balance: number }>(`/rooms/${roomId}/gifts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(burst ? { 'x-burst': '1' } : {}) },
      body: JSON.stringify({ giftId, tapId: crypto.randomUUID() }),
    });
    return { ok: true, balance: res.balance };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, status: err.status, error: err.message };
    return { ok: false, status: 0, error: 'network error' };
  }
}
