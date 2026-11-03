// Run by ConfigModule before anything is built. Each of these is read with
// Number() somewhere, and a typo there fails quietly instead: a NaN free-minute
// count never pauses video, a NaN share books NaN coins to the host.
export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  const problems: string[] = [];
  const text = (name: string) => String(env[name] ?? '').trim();

  const wholeNumber = (name: string, min: number, max: number) => {
    const raw = text(name);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      const range = max === Infinity ? `${min} or more` : `${min} to ${max}`;
      problems.push(`${name} must be a whole number, ${range} (got "${raw}")`);
    }
  };
  wholeNumber('AGORA_FREE_MINUTES', 1, Infinity);
  wholeNumber('HOST_SHARE_PCT', 0, 100);

  const budget = Number(text('BUDGET_TB_MONTH'));
  if (text('BUDGET_TB_MONTH') === '' || !Number.isFinite(budget) || budget <= 0) {
    problems.push(`BUDGET_TB_MONTH must be a number above 0 (got "${text('BUDGET_TB_MONTH')}")`);
  }

  // The value itself is never echoed.
  if (text('ADMIN_PASSWORD').length < 12) {
    problems.push('ADMIN_PASSWORD must be at least 12 characters');
  }

  if (problems.length) throw new Error(`invalid environment:\n  ${problems.join('\n  ')}`);
  return env;
}
