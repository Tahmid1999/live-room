export type GiftDef = { id: string; name: string; coins: number };

export const GIFTS: GiftDef[] = [
  { id: 'tea', name: 'Tea', coins: 10 },
  { id: 'rose', name: 'Rose', coins: 50 },
  { id: 'clap', name: 'Clap', coins: 100 },
  { id: 'star', name: 'Star', coins: 300 },
  { id: 'crown', name: 'Crown', coins: 500 },
];

// Four characters tell two taps apart on screen without publishing an id a
// client could replay.
export const tapLabel = (tapId: string) => `tap-${tapId.slice(0, 4).toLowerCase()}`;
