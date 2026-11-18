/** When to stop listening on its own (user's request, 18/11/2026): after «Oye Watson» or ⌃⌥W nobody presses the
 * microphone to stop, so it stops once the user has spoken and then kept quiet for a moment, or when nothing at
 * all is said. Pure: the loudness (0 to 1) and the time come from the microphone button. */
export type Silence = { startedAt: number; floor: number; samples: number; heard: boolean; quietSince: number | null };
export const QUIET_MS = 1_300;    // a pause this long after speaking ends the message
export const NOTHING_MS = 8_000;  // nothing said this long after starting: give up
const CALIBRATE_MS = 400;         // the room's own noise, measured at the start

export const silence = (now: number): Silence => ({ startedAt: now, floor: 0, samples: 0, heard: false, quietSince: null });

export function hear(s: Silence, level: number, now: number): { next: Silence; stop: 'done' | 'nothing' | null } {
  if (now - s.startedAt < CALIBRATE_MS && !s.heard) {
    const samples = s.samples + 1;
    return { next: { ...s, samples, floor: s.floor + (level - s.floor) / samples }, stop: null };
  }
  const voice = Math.max(0.03, s.floor * 2.5);
  if (level >= voice) return { next: { ...s, heard: true, quietSince: null }, stop: null };
  if (!s.heard) return { next: s, stop: now - s.startedAt >= NOTHING_MS ? 'nothing' : null };
  const quietSince = s.quietSince ?? now;
  return { next: { ...s, quietSince }, stop: now - quietSince >= QUIET_MS ? 'done' : null };
}
