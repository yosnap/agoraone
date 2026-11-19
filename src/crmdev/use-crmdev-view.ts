import { useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import type { CrmdevPage } from '../api/crmdev';

// What the «CRMDev» section has read, shared by its tabs and records: each read is asked once, when it is first shown,
// and kept while the section lives, so going back to a tab does not ask again (the core also keeps each list for 60 s,
// and CRMDev allows only 10 requests every 10 s). «Volver a leer» forgets everything and what is on screen asks again.
// Only the latest answer for a key counts.

/** Why a read failed: `kind` is the core's (`not_connected`, `off`, `busy`, `auth`, `forbidden`, `unreachable`…). */
export type CrmdevFailure = { message: string; kind: string | null; status: number };
export type CrmdevRead<T> = { data: T | null; failure: CrmdevFailure | null; loading: boolean };

const EMPTY: CrmdevRead<never> = { data: null, failure: null, loading: false };
const entries = new Map<string, CrmdevRead<unknown>>();
const generations = new Map<string, number>();
// Read before the latest «Volver a leer»: shown until the new answer arrives, then replaced.
const stale = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function failureOf(error: unknown): CrmdevFailure {
  if (error instanceof ApiError) {
    const kind = typeof error.data?.status === 'string' ? error.data.status : null;
    return { message: error.message, kind, status: error.status };
  }
  return { message: error instanceof Error ? error.message : 'No se pudo leer CRMDev.', kind: null, status: 0 };
}

/** Asks for `key` unless it is already read or being read. Called while rendering: it never notifies right away. */
export function ensureCrmdev<T>(key: string, fetcher: () => Promise<T>, again = false) {
  if (!again && entries.has(key) && !stale.has(key)) return;
  stale.delete(key);
  const mine = (generations.get(key) ?? 0) + 1;
  generations.set(key, mine);
  const before = entries.get(key) as CrmdevRead<T> | undefined;
  entries.set(key, { data: before?.data ?? null, failure: null, loading: true });
  void fetcher().then(data => { if (generations.get(key) === mine) entries.set(key, { data, failure: null, loading: false }); },
    error => { if (generations.get(key) === mine) entries.set(key, { data: null, failure: failureOf(error), loading: false }); })
    .finally(() => { if (generations.get(key) === mine) notify(); });
  if (again) notify();
}

/** The read of `key` (null: nothing to read, e.g. a contact in discreet mode), asked on first use. */
export function useCrmdevRead<T>(key: string | null, fetcher: () => Promise<T>): CrmdevRead<T> & { reload: () => void } {
  if (key) ensureCrmdev(key, fetcher);
  const snapshot = () => (key ? entries.get(key) ?? EMPTY : EMPTY);
  const read = useSyncExternalStore(subscribe, snapshot, snapshot) as CrmdevRead<T>;  // the same on a server render (the tests)
  return { ...read, reload: () => { if (key) ensureCrmdev(key, fetcher, true); } };
}

/** «Volver a leer»: every read is asked again when shown, keeping what was read on screen until the new answer comes
 * (so an open record built from its list stays open). */
export function forgetCrmdev() {
  for (const key of entries.keys()) stale.add(key);
  notify();
}

/** A fresh start each time the section opens, without notifying: nothing of the section is on screen yet. */
export function startCrmdev() {
  entries.clear();
  stale.clear();
}

/** A key for a read and its parameters, the same whatever their order; empty parameters are left out. */
export const readKey = (name: string, params: Record<string, string | undefined> = {}) =>
  `${name}?${Object.entries(params).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;

export type CrmdevTabName = 'proyectos' | 'tareas' | 'tickets' | 'clientes';
/** The tabs of the section, in order; each one reads only its own list when opened. */
export const crmdevTabs: { id: CrmdevTabName; label: string }[] = [
  { id: 'proyectos', label: 'Proyectos' }, { id: 'tareas', label: 'Tareas' }, { id: 'tickets', label: 'Tickets' }, { id: 'clientes', label: 'Clientes' },
];

/** What a full list holds, said truthfully: CRMDev has no pages, so only 100 rows come and the rest is only in CRMDev. */
export function orderNote(page: Pick<CrmdevPage<unknown>, 'more' | 'order' | 'limit'>): string | null {
  if (!page.more) return null;
  return page.order === 'primeros'
    ? `Los ${page.limit} primeros (por antigüedad): CRMDev no da más de ${page.limit} y el resto solo se ve allí.`
    : `Los ${page.limit} más recientes: CRMDev no da más de ${page.limit} y el resto solo se ve allí.`;
}

/** The distinct, non-empty names of some rows, sorted as in Spanish. */
export const namesOf = (values: (string | null | undefined)[]) =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) => a.localeCompare(b, 'es'));
