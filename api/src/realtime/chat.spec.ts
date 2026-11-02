import { cleanChat } from './chat';

describe('cleanChat', () => {
  it('rejects blank text as empty', () => {
    expect(cleanChat('  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a message that is only a link', () => {
    expect(cleanChat('https://x.io')).toEqual({ ok: false, reason: 'link-only' });
    expect(cleanChat('promo.xyz/win')).toEqual({ ok: false, reason: 'link-only' });
  });

  it('strips a link from the middle and closes the gap', () => {
    expect(cleanChat('hi https://x.io there')).toEqual({ ok: true, text: 'hi there' });
    expect(cleanChat('see foo.com now')).toEqual({ ok: true, text: 'see now' });
  });

  it('cuts to 140 characters', () => {
    expect(cleanChat('a'.repeat(141))).toEqual({ ok: true, text: 'a'.repeat(140) });
  });

  it('does not cut a character in half', () => {
    const res = cleanChat('\u{1F600}'.repeat(141));
    expect(res.ok && [...res.text].length).toBe(140);
  });

  it('blocks listed words and their endings, but not words that merely contain them', () => {
    expect(cleanChat('you are a Bitch')).toEqual({ ok: false, reason: 'blocked' });
    expect(cleanChat('shitty stream')).toEqual({ ok: false, reason: 'blocked' });
    expect(cleanChat('classic assist')).toEqual({ ok: true, text: 'classic assist' });
  });

  it('stays fast on a huge input with no spaces', () => {
    const start = performance.now();
    const res = cleanChat('a'.repeat(100_000));
    expect(performance.now() - start).toBeLessThan(50);
    expect(res.ok && res.text.length).toBe(140);
  });
});
