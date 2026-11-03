import { validateEnv } from './env';

const good = {
  AGORA_FREE_MINUTES: '10000',
  HOST_SHARE_PCT: '60',
  BUDGET_TB_MONTH: '20',
  ADMIN_PASSWORD: 'twelve-chars',
  WEB_ORIGIN: 'https://live.example.com',
};

describe('validateEnv', () => {
  it('passes a complete environment through unchanged', () => {
    expect(validateEnv({ ...good, OTHER: 'x' })).toEqual({ ...good, OTHER: 'x' });
  });

  it.each([
    ['AGORA_FREE_MINUTES', 'ten thousand'],
    ['AGORA_FREE_MINUTES', ''],
    ['AGORA_FREE_MINUTES', '0'],
    ['AGORA_FREE_MINUTES', '10000.5'],
    ['HOST_SHARE_PCT', '101'],
    ['HOST_SHARE_PCT', '-1'],
    ['HOST_SHARE_PCT', '60%'],
    ['BUDGET_TB_MONTH', 'NaN'],
    ['BUDGET_TB_MONTH', 'Infinity'],
    ['BUDGET_TB_MONTH', '0'],
    ['BUDGET_TB_MONTH', undefined],
    ['WEB_ORIGIN', undefined],
    ['WEB_ORIGIN', 'https://live.example.com/'],
    ['WEB_ORIGIN', 'live.example.com'],
  ])('refuses %s=%p', (name, value) => {
    expect(() => validateEnv({ ...good, [name]: value })).toThrow(name);
  });

  it('takes a fractional budget', () => {
    expect(() => validateEnv({ ...good, BUDGET_TB_MONTH: '2.5' })).not.toThrow();
  });

  it('refuses a short admin password without printing it', () => {
    expect(() => validateEnv({ ...good, ADMIN_PASSWORD: 'eleven-char' })).toThrow(
      'ADMIN_PASSWORD must be at least 12 characters',
    );
    expect(() => validateEnv({ ...good, ADMIN_PASSWORD: 'eleven-char' })).not.toThrow('eleven-char');
  });

  it('lists every problem at once', () => {
    expect(() => validateEnv({ ...good, HOST_SHARE_PCT: 'x', ADMIN_PASSWORD: 'short' })).toThrow(
      /HOST_SHARE_PCT[^]*ADMIN_PASSWORD/,
    );
  });
});
