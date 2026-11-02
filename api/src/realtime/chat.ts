const MAX_LENGTH = 140;
const URL_FULL = /https?:\/\/\S+/gi;
// A token with a domain-looking dot inside it. Tested per token, not as a
// global /\S+\.com/ over the whole text: that backtracks quadratically on a
// long run with no spaces.
const BARE_DOMAIN = /.\.(com|net|org|io|xyz|ru)/i;
// Socket.IO will hand over up to its buffer limit; nothing past this can
// survive the 140 cut anyway, so it is dropped before any regex runs.
const MAX_RAW = 1000;

// Kept short on purpose: a long list mostly produces false positives and a
// demo room needs a basic gate, not moderation.
const BLOCKED = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard'];

export type CleanChat =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'link-only' | 'blocked' };

export function cleanChat(raw: string): CleanChat {
  const trimmed = raw.slice(0, MAX_RAW).trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Links go before the cut, so a long URL cannot use up the 140 characters.
  const stripped = trimmed
    .replace(URL_FULL, ' ')
    .split(/\s+/)
    .filter((token) => token && !BARE_DOMAIN.test(token))
    .join(' ');
  if (!stripped) return { ok: false, reason: 'link-only' };

  // Spread, not slice: slice would split an emoji's surrogate pair.
  const text = [...stripped].slice(0, MAX_LENGTH).join('').trimEnd();

  // Prefix match so "shitty" is caught; whole-token so "assist" is not.
  const words = text.toLowerCase().split(/[^a-z]+/);
  if (words.some((w) => BLOCKED.some((b) => w.startsWith(b)))) {
    return { ok: false, reason: 'blocked' };
  }
  return { ok: true, text };
}
