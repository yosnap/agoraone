/** When to stop listening on its own (user's request, 18/11/2026): after «Oye Watson» or ⌃⌥W nobody presses the
 * microphone to stop, so it stops once the user has spoken and then kept quiet for a moment, or when nothing at
 * all is said. Pure: the loudness (0 to 1) and the time come from the microphone button.
 * The first moments only measure the room: the end of «Oye Watson» and the start sound fall there and must not
 * count as the message (otherwise it stopped right after the call, with nothing said). Speech counts once it has
 * lasted a little, so a cough or a click does not start the countdown either. */
export type Silence = { startedAt: number; floor: number; voiced: number; heard: boolean; quietSince: number | null; last: number };
export const GRACE_MS = 800;      // only the room's noise is measured
export const SPEECH_MS = 400;     // this much voice before it counts as speaking
export const QUIET_MS = 1_800;    // a pause this long after speaking ends the message
export const NOTHING_MS = 10_000; // nothing said this long after starting: give up

export const silence = (now: number): Silence => ({ startedAt: now, floor: 1, voiced: 0, heard: false, quietSince: null, last: now });

export function hear(s: Silence, level: number, now: number): { next: Silence; stop: 'done' | 'nothing' | null } {
  const step = now - s.last;
  // The quietest moment of the start is the room: speech in it (the call's tail) does not raise it.
  if (now - s.startedAt < GRACE_MS) return { next: { ...s, floor: Math.min(s.floor, level), last: now }, stop: null };
  const voice = Math.max(0.03, Math.min(s.floor, 0.2) * 2.5);
  if (level >= voice) {
    const voiced = s.voiced + step;
    return { next: { ...s, voiced, heard: s.heard || voiced >= SPEECH_MS, quietSince: null, last: now }, stop: null };
  }
  if (!s.heard) return { next: { ...s, last: now }, stop: now - s.startedAt >= NOTHING_MS ? 'nothing' : null };
  const quietSince = s.quietSince ?? now;
  return { next: { ...s, quietSince, last: now }, stop: now - quietSince >= QUIET_MS ? 'done' : null };
}
