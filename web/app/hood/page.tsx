'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { clock } from '@/lib/format';

type HoodEvent = { t: number; kind: string; replica: string; text: string };

const KEEP = 200;
const RETRY_MS = 3000;
// Refusals and kills are the lines worth noticing; everything else stays ink.
const ALERTS = ['kill', 'rate-limit'];

export default function Hood() {
  const [events, setEvents] = useState<HoodEvent[]>([]);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let source: EventSource;
    let retry: ReturnType<typeof setTimeout>;

    const open = () => {
      source = new EventSource(`${API_BASE}/events/stream`);
      source.onopen = () => setDown(false);
      source.onmessage = (msg) => {
        let ev: HoodEvent;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          return;
        }
        setEvents((prev) => {
          // A reconnect replays the backlog; (t, text) is what makes a line the same line.
          if (prev.some((p) => p.t === ev.t && p.text === ev.text)) return prev;
          // Sorted rather than prepended: an event missed while disconnected
          // arrives in the replay and belongs below newer lines. The new one goes
          // first so that, at equal t, the later arrival stays on top.
          return [ev, ...prev].sort((a, b) => b.t - a.t).slice(0, KEEP);
        });
      };
      source.onerror = () => {
        setDown(true);
        // While CONNECTING the browser retries by itself. After a non-200 answer
        // (a proxy 502 mid-deploy) it gives up for good, so a new one is opened.
        if (source.readyState === EventSource.CLOSED) retry = setTimeout(open, RETRY_MS);
      };
    };
    open();

    return () => {
      clearTimeout(retry);
      source.close();
    };
  }, []);

  return (
    <main className="hood mono">
      {down && <p className="hood-empty">reconnecting</p>}
      {!down && events.length === 0 && <p className="hood-empty">waiting for events</p>}
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
