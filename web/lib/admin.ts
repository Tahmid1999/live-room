import { call } from './api';

export type AdminRoom = {
  id: string;
  kind: 'VIDEO' | 'AUDIO';
  title: string;
  hostName: string;
  house: boolean;
  status: 'LIVE' | 'ENDED' | 'KILLED';
  viewers: number;
  perViewerBps: number;
  totalBps: number;
  ageSec: number;
};

export type AdminGift = { at: number; guest: string; room: string; giftId: string; coins: number };

export type Wallets = { coinsInCirculation: number; ledgerSum: number; giftsToday: number };

export type Payouts = {
  earningsUnsettled: number;
  runs: { id: string; replica: string; startedAt: string; finishedAt: string; rows: number; total: number }[];
  payouts: { id: string; runId: string; roomId: string; amount: number; createdAt: string }[];
};

export const getAdminRooms = () => call<AdminRoom[]>('/admin/rooms');
export const getAdminGifts = () => call<AdminGift[]>('/admin/gifts?limit=50');
export const getWallets = () => call<Wallets>('/admin/wallets');
export const getPayouts = () => call<Payouts>('/admin/payouts');
export const getAdminMe = () => call<{ admin: boolean }>('/admin/me');

export const killRoom = (id: string) =>
  call<{ id: string; status: string }>(`/admin/rooms/${id}/kill`, { method: 'POST' });

export const login = (password: string) =>
  call<{ admin: boolean }>('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
