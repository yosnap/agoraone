import { ApiError } from '../api/client';

/** Delays between tries of one microphone piece: about 15 s in all, well inside the 45 s the core waits
 * before it stops a meeting left without pieces. */
export const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000];

/** A failure worth trying again: the network or the core did not answer (no status, or 5xx). A 4xx is the
 * core's own answer (the meeting is no longer recording, the piece is too big) and trying again won't help. */
export function transient(failure: unknown): boolean {
  if (failure instanceof ApiError) return failure.status === 0 || failure.status >= 500;
  return true;
}

/** Sends one piece, trying again on transient failures; throws the last failure when it gives up. */
export async function withRetries<T>(send: () => Promise<T>, wait = (ms: number) => new Promise(done => setTimeout(done, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(); }
    catch (failure) {
      if (!transient(failure) || attempt >= RETRY_DELAYS.length) throw failure;
      await wait(RETRY_DELAYS[attempt]);
    }
  }
}
