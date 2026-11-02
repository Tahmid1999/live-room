const MAX_LENGTH = 140;
const URL_FULL = /https?:\/\/\S+/gi;
const URL_BARE = /\S+\.(com|net|org|io|xyz|ru)\S*/gi;

// Kept short on purpose: a long list mostly produces false positives and a
// demo room needs a basic gate, not moderation.
const BLOCKED = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard'];

export type CleanChat =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'link-only' | 'blocked' };

export function cleanChat(raw: string): CleanChat {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Links go before the cut, so a long URL cannot use up the 140 characters.
  const stripped = trimmed
    .replace(URL_FULL, ' ')
    .replace(URL_BARE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
