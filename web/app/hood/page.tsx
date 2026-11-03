'use client';

import { useEffect, useState } from 'react';
import { clock } from '@/lib/format';

type HoodEvent = { t: number; kind: string; replica: string; text: string };

const KEEP = 200;
// Refusals and kills are the lines worth noticing; everything else stays ink.
const ALERTS = ['kill', 'rate-limit'];

export default function Hood() {
  const [events, setEvents] = useState<HoodEvent[]>([]);

  useEffect(() => {
    const source = new EventSource('/api/events/stream');
    source.onmessage = (msg) => {
      const ev: HoodEvent = JSON.parse(msg.data);
      setEvents((prev) => {
        // A reconnect replays the backlog; (t, text) is what makes a line the same line.
        if (prev.some((p) => p.t === ev.t && p.text === ev.text)) return prev;
        // Sorted rather than prepended: an event missed while disconnected
        // arrives in the replay and belongs below newer lines. The new one goes
        // first so that, at equal t, the later arrival stays on top.
        return [ev, ...prev].sort((a, b) => b.t - a.t).slice(0, KEEP);
      });
    };
    return () => source.close();
  }, []);

  return (
    <main className="hood mono">
      {events.length === 0 && <p className="hood-empty">waiting for events</p>}
      <ul>
        {events.map((e) => (
          <li key={`${e.t}|${e.text}`} className={ALERTS.includes(e.kind) ? 'err' : undefined}>
            <span className="hood-time">{clock(e.t)}</span> {e.text}
          </li>
        ))}
      </ul>
    </main>
  );
}
