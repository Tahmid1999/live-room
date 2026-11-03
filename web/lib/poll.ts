import { useCallback, useEffect, useState } from 'react';

// Keeps the last good answer when a poll fails, so a blip does not blank a table.
// The next request is scheduled when the last one settles, so a slow API is
// never asked twice at once, and a hidden tab asks nothing until it is shown.
export function usePoll<T>(load: () => Promise<T>, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;

    const run = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const next = await load();
        if (stopped) return;
        setData(next);
        setFailed(false);
      } catch {
        if (stopped) return;
        setFailed(true);
      } finally {
        busy = false;
      }
      timer = setTimeout(run, everyMs);
    };
    // Back on screen: ask now instead of waiting out a timer that never ran.
    const resume = () => {
      if (!document.hidden && !stopped) {
        clearTimeout(timer);
        void run();
      }
    };

    void run();
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [load, everyMs, tick]);

  return { data, failed, reload };
}
