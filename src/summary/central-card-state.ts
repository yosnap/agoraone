import type { CentralState } from '../api/core';

export type CentralCardView = 'loading' | 'not_connected' | 'not_read' | 'snapshot';

/** What the Central card shows: a stored snapshot is always shown, also without a connection (it was read before,
 * for instance by the old folder way), next to the notice on how to connect now. */
export function centralCardView(state: CentralState | null): CentralCardView {
  if (!state) return 'loading';
  if (state.snapshot) return 'snapshot';
  return state.configured ? 'not_read' : 'not_connected';
}

/** Whether there are Central servers worth a block on the home screen: connected, or a snapshot kept from before. */
export function hasCentralData(state: CentralState | null): boolean {
  return !!state && (state.configured || !!state.snapshot);
}
