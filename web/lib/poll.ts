import { useCallback, useEffect, useState } from 'react';

// Keeps the last good answer when a poll fails, so a blip does not blank a table.
export function usePoll<T>(load: () => Promise<T>, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    const run = () =>
      load().then(
        (next) => {
          if (stopped) return;
          setData(next);
          setFailed(false);
        },
        () => !stopped && setFailed(true),
      );
    run();
    const timer = setInterval(run, everyMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [load, everyMs, tick]);

  return { data, failed, reload };
}
