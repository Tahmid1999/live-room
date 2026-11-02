import Redlock, { ExecutionError } from 'redlock';

const LOCK_TTL_MS = 60_000;

// Returns null when another replica holds the lock. retryCount 0 because the
// global setting waits ~5 s and would then run anyway, so the losing replica
// would do the work right after the winner.
export async function runLocked<T>(
  redlock: Redlock,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lock = await redlock.acquire([key], LOCK_TTL_MS, { retryCount: 0 }).catch((err) => {
    if (err instanceof ExecutionError) return null;
    throw err;
  });
  if (!lock) return null;
  try {
    return await fn();
  } finally {
    // The lock may already have expired during a long run; there is nothing
    // to undo, and this must not replace the run's own result or error.
    await lock.release().catch(() => {});
  }
}
