import { useSyncExternalStore } from 'react';

/** A request from another section (the «Agentes» cards) for the office: show this agent in the city, or open its
 * chat. Each request has its own number, so the office acts on it once. */
export type OfficeFocus = { id: string; mode: 'select' | 'chat'; n: number };

let focus: OfficeFocus | null = null;
const listeners = new Set<() => void>();

export function requestOffice(id: string, mode: OfficeFocus['mode']) {
  focus = { id, mode, n: (focus?.n ?? 0) + 1 };
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useOfficeFocus = () => useSyncExternalStore(subscribe, () => focus);
