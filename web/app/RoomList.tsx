'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getRooms, RoomCard } from '@/lib/api';

export function RoomList({ current }: { current?: string }) {
  const [rooms, setRooms] = useState<RoomCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getRooms().then(
        (list) => {
          if (stopped) return;
          setRooms(list);
          setFailed(false);
        },
        () => !stopped && setFailed(true),
      );
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (failed && !rooms) return <p className="err">Could not reach the server.</p>;
  if (!rooms) return <p className="empty">Loading rooms</p>;
  if (!rooms.length) return <p className="empty">No rooms are live right now.</p>;

  return (
    <ul className="rooms">
      {rooms.map((r) => (
        <li key={r.id}>
          <Link
            href={`/r/${r.id}`}
            className="room-link"
            aria-current={r.id === current ? 'page' : undefined}
          >
            <span className="room-head">
              <span>{r.title}</span>
              <span className="badge mono">{r.engine === 'agora' ? 'Agora' : 'LiveKit'}</span>
            </span>
            <span className="room-meta">
              <span>{r.kind === 'VIDEO' ? 'video room' : 'audio room'}</span>
              {r.startsOnOpen && r.viewers === 0 ? (
                <span>starts when you open it</span>
              ) : (
                <span className="mono">{r.viewers} watching</span>
              )}
              {r.house && <span>house stream</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
