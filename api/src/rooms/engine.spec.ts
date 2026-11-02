import { engineFor } from './engine';
import { agoraUidFor } from './tokens';

describe('engineFor', () => {
  it('sends video to agora', () => {
    expect(engineFor('VIDEO')).toBe('agora');
  });

  it('sends audio to livekit', () => {
    expect(engineFor('AUDIO')).toBe('livekit');
  });
});

describe('agoraUidFor', () => {
  it('is stable for one guest id', () => {
    const id = '65a1b2c3d4e5f60718293a4b';
    expect(agoraUidFor(id)).toBe(agoraUidFor(id));
  });

  it('stays a positive 31-bit number and never takes the any-uid or house uid', () => {
    for (let i = 0; i < 2000; i++) {
      const uid = agoraUidFor(i.toString(16).padStart(24, '0'));
      expect(Number.isInteger(uid)).toBe(true);
      expect(uid).toBeGreaterThanOrEqual(2);
      expect(uid).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});
