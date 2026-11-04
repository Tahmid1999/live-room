export type PlayerEvents = {
  // true when a remote track starts playing, false when the last one goes.
  onLive(live: boolean): void;
  // A line for the viewer when the stream breaks; '' clears it.
  onProblem(text: string): void;
  // The server will not renew this seat; only a fresh join gets the stream back.
  onReopen(text: string): void;
};
