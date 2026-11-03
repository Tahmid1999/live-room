'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  Bandwidth,
  getBandwidth,
  getMe,
  getRooms,
  GIFTS,
  GiftId,
  joinRoom,
  Me,
  RoomCard,
  sendGift,
} from '@/lib/api';
import { engineLine } from '@/lib/format';
import type { Player, PlayerEvents } from '@/lib/players/player';
import { openRoomSocket } from '@/lib/socket';
import { startStats } from '@/lib/stats';
import { Who } from '@/app/Who';

type Line =
  | { kind: 'chat'; name: string; text: string; at: number }
  | { kind: 'gift'; name: string; giftId: string; coins: number; at: number };

type Standing = { name: string; coins: number };

const KEEP_LINES = 100;
const BURST = 20;

const chatReasons: Record<string, string> = {
  'slow-down': 'one message a second',
  'link-only': 'links are removed, so nothing was left to send',
  blocked: 'that message was filtered',
  empty: 'type something first',
};

const giftName = (id: string) => GIFTS.find((g) => g.id === id)?.name ?? id;

async function makePlayer(engine: 'agora' | 'livekit', events: PlayerEvents): Promise<Player> {
  // Dynamic, and one or the other: a LiveKit room never downloads the Agora SDK.
  if (engine === 'agora') return new (await import('@/lib/players/agora')).AgoraPlayer(events);
  return new (await import('@/lib/players/livekit')).LiveKitPlayer(events);
}

// Nest sends a WsException's { error } body as the payload itself, while an
// unexpected failure arrives as { status: 'error', message }.
type SocketException = { error?: string; message?: string };

export function Room({ id }: { id: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [card, setCard] = useState<RoomCard | null>(null);
  const [engine, setEngine] = useState<'agora' | 'livekit' | null>(null);
  const [live, setLive] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [closed, setClosed] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [top, setTop] = useState<Standing[]>([]);
  const [viewers, setViewers] = useState(0);
  const [bw, setBw] = useState<Bandwidth | null>(null);
  const [gift, setGift] = useState<GiftId>('clap');
  const [giftNote, setGiftNote] = useState('');
  const [burst, setBurst] = useState('');
  const [bursting, setBursting] = useState(false);
  const [draft, setDraft] = useState('');
  const [chatNote, setChatNote] = useState('');

  const mount = useRef<HTMLDivElement>(null);
  const socket = useRef<Socket | null>(null);
  const log = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // Everything this run owns is local, so the unmount-and-mount a dev build
    // does cannot leave one run closing the other's socket or player.
    let cancelled = false;
    let ended = false;
    let player: Player | null = null;
    let sock: Socket | null = null;
    let stopStats = () => {};

    const push = (line: Line) => setLines((prev) => [...prev, line].slice(-KEEP_LINES));
    // Kill and refusal both mean this viewer is no longer in the room.
    const leaveRoom = () => {
      ended = true;
      stopStats();
      void player?.stop();
    };
    const events: PlayerEvents = {
      onLive: (v) => !cancelled && !ended && setLive(v),
      onProblem: (text) => !cancelled && !ended && setPlayerError(text),
    };

    async function run() {
      try {
        // The guest cookie has to exist before the socket handshake reads it.
        const [mine, rooms] = await Promise.all([getMe(), getRooms()]);
        if (cancelled) return;
        setMe(mine);
        setCard(rooms.find((r) => r.id === id) ?? null);

        const info = await joinRoom(id);
        if (cancelled) return;
        setEngine(info.engine);

        const s = openRoomSocket(id);
        sock = s;
        socket.current = s;
        s.on('chat', (m: { name: string; text: string; at: number }) => push({ ...m, kind: 'chat' }));
        s.on('chat:history', ({ items }: { items: { name: string; text: string; at: number }[] }) =>
          // A reconnect sends the history again: swap the chat lines for it
          // and keep the gift lines, which it does not carry.
          setLines((prev) =>
            [...items.map((m) => ({ ...m, kind: 'chat' as const })), ...prev.filter((l) => l.kind === 'gift')]
              .sort((a, b) => a.at - b.at)
              .slice(-KEEP_LINES),
          ),
        );
        s.on('gift', (g: { name: string; giftId: string; coins: number; at: number }) =>
          push({ ...g, kind: 'gift' }),
        );
        s.on('chat:rejected', ({ reason }: { reason: string }) => setChatNote(chatReasons[reason] ?? reason));
        s.on('lb', ({ top }: { top: Standing[] }) => setTop(top));
        s.on('viewers', ({ count }: { count: number }) => setViewers(count));
        s.on('room:killed', () => {
          leaveRoom();
          setClosed(true);
        });
        // A reconnect that the server refuses (room ended, paused) arrives here.
        s.on('exception', (e: SocketException) => {
          if (!e.error) {
            // Transient server trouble: the socket reconnects and rejoins by itself.
            setChatNote(e.message ?? 'server error');
            return;
          }
          leaveRoom();
          setJoinError(e.error);
        });
        stopStats = startStats(s, () => player?.bitrate() ?? 0);

        const p = await makePlayer(info.engine, events);
        if (cancelled) return;
        player = p;
        if (ended) return;
        try {
          await p.start(mount.current!, info);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          const what = info.engine === 'agora' ? 'video' : 'audio';
          events.onProblem(`${what} could not start · ${e.code ?? e.message}`);
        }
        // Left or killed while the player was still joining: the cleanup or the
        // kill handler ran before there was anything to stop.
        if (cancelled || ended) void p.stop();
      } catch (err) {
        if (!cancelled) setJoinError((err as Error).message);
      }
    }
    run();

    return () => {
      cancelled = true;
      stopStats();
      sock?.emit('room:leave');
      sock?.close();
      if (socket.current === sock) socket.current = null;
      void player?.stop();
    };
  }, [id]);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getBandwidth().then(
        (b) => !stopped && setBw(b),
        () => {},
      );
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines]);

  // A refused join leaves a visitor who can see the room but is not in it:
  // chat would be dropped and gifts would still spend their coins.
  const blocked = closed || !!joinError;

  async function tap(giftId: GiftId) {
    setGift(giftId);
    setGiftNote('');
    const res = await sendGift(id, giftId);
    if (res.ok) setMe((m) => m && { ...m, balance: res.balance });
    else setGiftNote(res.error);
  }

  async function sendBurst() {
    setBursting(true);
    setBurst('');
    setGiftNote('');
    try {
      const results = await Promise.all(Array.from({ length: BURST }, () => sendGift(id, gift, true)));
      const ok = results.flatMap((r) => (r.ok ? [r.balance] : []));
      const reasons = [...new Set(results.flatMap((r) => (r.ok ? [] : [r.error])))];
      // Balances only fall, so the lowest one is the state after the last tap
      // to land, whatever order the responses came back in.
      const balance = ok.length ? Math.min(...ok) : (await getMe()).balance;
      setMe((m) => m && { ...m, balance });
      const refused = BURST - ok.length;
      setBurst(
        `${BURST} sent · ${ok.length} ok · ${refused} refused${reasons.length ? ` (${reasons.join(', ')})` : ''} · balance ${balance}`,
      );
    } catch (err) {
      setGiftNote((err as Error).message);
    } finally {
      setBursting(false);
    }
  }

  function say(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setChatNote('');
    socket.current?.emit('chat:send', { text: draft });
    setDraft('');
  }

  const isAudio = engine ? engine === 'livekit' : card?.kind === 'AUDIO';
  const problem = closed ? 'room closed by admin' : joinError || playerError;
  const waiting = isAudio ? 'waiting for the host to start audio' : 'starting stream · ~5 s';
  const stageNote = problem || (live ? '' : waiting);
  const price = GIFTS.find((g) => g.id === gift)!.coins;

  return (
    <main className="col">
      <div className="top">
        <Link href="/" className="back">
          &lsaquo; rooms
        </Link>
        <Who me={me} />
      </div>
      <div className="top">
        <h1>{card?.title ?? 'Room'}</h1>
        <span className="mono who">{viewers} watching</span>
      </div>

      <div className={`stage ${isAudio ? 'audio' : 'video'}`}>
        <div ref={mount} className="mount" />
        {live && !blocked && <span className="live mono">LIVE</span>}
        {stageNote && <p className={`stage-note ${problem ? 'err' : ''}`}>{stageNote}</p>}
      </div>
      <p className="engine mono">{engine ? engineLine(engine, bw) : ' '}</p>

      <h2 className="label">Chat</h2>
      <ul className="chat" ref={log}>
        {lines.length === 0 && <li className="empty">Nothing said yet.</li>}
        {lines.map((l, i) =>
          l.kind === 'chat' ? (
            <li key={i}>
              <span className="name">{l.name}</span> {l.text}
            </li>
          ) : (
            <li key={i} className="gift mono">
              {l.name} sent {giftName(l.giftId)} · {l.coins}
            </li>
          ),
        )}
      </ul>
      <form className="compose" onSubmit={say}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={140}
          placeholder="Say something"
          aria-label="Chat message"
          disabled={blocked}
        />
        <button className="btn solid" disabled={blocked}>
          Send
        </button>
      </form>
      <p className="note err">{chatNote}</p>

      <h2 className="label">Gifts</h2>
      <div className="tray">
        {GIFTS.map((g) => (
          <button
            key={g.id}
            className="gift-btn"
            aria-pressed={g.id === gift}
            disabled={blocked || !me}
            onClick={() => tap(g.id)}
          >
            {g.name}
            <span className="mono">{g.coins}</span>
          </button>
        ))}
      </div>
      <div className="burst">
        <button className="btn" onClick={sendBurst} disabled={blocked || !me || bursting}>
          Send x{BURST}
        </button>
        <span className="mono">
          {BURST} × {giftName(gift)} = {(BURST * price).toLocaleString('en-US')} coins
        </span>
      </div>
      <p className="result mono">{burst}</p>
      <p className="note err">{giftNote}</p>

      <h2 className="label">Top gifters</h2>
      <ol className="board">
        {top.length === 0 && <li className="empty">No gifts yet.</li>}
        {top.map((t, i) => (
          <li key={t.name}>
            <span>
              {i + 1}. {t.name}
            </span>
            <span className="mono">{t.coins}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}
