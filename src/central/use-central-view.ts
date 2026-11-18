import { useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import type { CentralViewName } from '../api/central';

// What the «Central» section has read, shared by its tabs: each view (or record) is asked once, when it is first
// shown, and kept while the section lives, so going back to a tab does not ask Central again. «Volver a leer»
// forgets everything and the views on screen ask again. Only the latest answer for a view counts.

/** Why a read failed: `kind` is the core's (`not_connected`, `off`, `forbidden`, `unreachable`…). */
export type CentralFailure = { message: string; kind: string | null; status: number };
export type CentralRead<T> = { data: T | null; failure: CentralFailure | null; loading: boolean };

/** The key of the connection's read, kept by «Volver a leer». */
export const CONNECTION = 'conexion';
const EMPTY: CentralRead<never> = { data: null, failure: null, loading: false };
const entries = new Map<string, CentralRead<unknown>>();
const generations = new Map<string, number>();
const listeners = new Set<() => void>();
let readings = 0;
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function failureOf(error: unknown): CentralFailure {
  if (error instanceof ApiError) {
    const kind = typeof error.data?.status === 'string' ? error.data.status : null;
    return { message: error.message, kind, status: error.status };
  }
  return { message: error instanceof Error ? error.message : 'No se pudo leer Central.', kind: null, status: 0 };
}

/** Asks for `key` unless it is already read or being read. Called while rendering: it never notifies right away. */
export function ensureCentral<T>(key: string, fetcher: () => Promise<T>, again = false) {
  if (!again && entries.has(key)) return;
  const mine = (generations.get(key) ?? 0) + 1;
  generations.set(key, mine);
  const before = entries.get(key) as CentralRead<T> | undefined;
  entries.set(key, { data: before?.data ?? null, failure: null, loading: true });
  void fetcher().then(data => { if (generations.get(key) === mine) entries.set(key, { data, failure: null, loading: false }); },
    error => { if (generations.get(key) === mine) entries.set(key, { data: null, failure: failureOf(error), loading: false }); })
    .finally(() => { if (generations.get(key) === mine) notify(); });
  if (again) notify();
}

/** The read of `key` (null: nothing to read), asked on first use. */
export function useCentralRead<T>(key: string | null, fetcher: () => Promise<T>): CentralRead<T> & { reload: () => void } {
  if (key) ensureCentral(key, fetcher);
  const read = useSyncExternalStore(subscribe, () => (key ? entries.get(key) ?? EMPTY : EMPTY)) as CentralRead<T>;
  return { ...read, reload: () => { if (key) ensureCentral(key, fetcher, true); } };
}

/** «Volver a leer»: forgets every view (not the connection, so the tabs stay); the ones on screen are asked again. */
export function forgetCentral() {
  for (const key of [...entries.keys()]) if (key !== CONNECTION) entries.delete(key);
  readings++;
  notify();
}

/** How many times «Volver a leer» was pressed: what depends on earlier pages (the cursors) starts again with it. */
export const useCentralReadings = () => useSyncExternalStore(subscribe, () => readings);

/** A key for a view and its parameters, the same whatever the order of the parameters. */
export const viewKey = (view: CentralViewName, params: Record<string, string | undefined> = {}) =>
  `${view}?${Object.entries(params).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;

export type CentralTab = { id: CentralViewName; label: string };
/** The tabs of the section, in order; each one reads only its own view when opened. */
export const centralTabs: CentralTab[] = [
  { id: 'resumen', label: 'Resumen' }, { id: 'alertas', label: 'Alertas' }, { id: 'pendientes', label: 'Pendientes' },
  { id: 'clientes', label: 'Clientes' }, { id: 'proyectos', label: 'Proyectos' },
];

const clock = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

const dayOf = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

/** «leído a las 10:30» for a snapshot of today (Madrid's time), «leído el 15 nov 2026 a las 10:30» for an older
 * one, so an old copy never looks current; empty when the time is unknown. */
export function readAtLabel(iso: string | null | undefined, now = new Date()) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const today = dayOf.format(at) === dayOf.format(now);
  return today ? `leído a las ${clock.format(at)}` : `leído el ${dayOf.format(at)} a las ${clock.format(at)}`;
}

/** A date of Central in Madrid's time, or «—». */
export function dateLabel(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? day.format(at) : '—';
}

/** A fresh start each time the section opens: whatever was read on a previous visit (or before connecting) is
 * forgotten without notifying, since nothing of the section is on screen yet. */
export function startCentral() {
  entries.clear();
}
