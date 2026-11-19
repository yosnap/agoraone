import { useCallback, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';

// A store of reads for a section that shows a remote service (Central, CRMDev…): each read has a key, is asked once
// when something on screen first watches it and is kept while the section lives, so going back to a tab asks nothing.
//
// Invariants:
// - Nothing is asked while React renders: a read starts when a component subscribes (after it is on screen), or from
//   a handler («Reintentar», «Volver a leer»). A render that React throws away asks nothing.
// - Only the latest answer for a key counts (a generation per key).
// - `forget` («Volver a leer») gives every watched read a new entry right away, so what is on screen is asked again
//   at once; reads not on screen are dropped and asked when shown again.
// - `start` (a new visit) only empties the store without notifying: calling it twice is harmless.

/** Why a read failed: `kind` is the core's (`not_connected`, `off`, `busy`, `auth`, `unreachable`…). */
export type ReadFailure = { message: string; kind: string | null; status: number };
export type Read<T> = { data: T | null; failure: ReadFailure | null; loading: boolean };
/** Asks for a read; `fresh` is true for «Volver a leer» (a service may then skip its own cache). */
export type Fetcher<T> = (fresh: boolean) => Promise<T>;
export type ReadStore = ReturnType<typeof createReadStore>;

const EMPTY: Read<never> = { data: null, failure: null, loading: false };

/** A key for a read and its parameters, the same whatever their order; empty parameters are left out. */
export const readKey = (name: string, params: Record<string, string | undefined> = {}) =>
  `${name}?${Object.entries(params).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;

export function createReadStore(fallbackMessage: string) {
  const entries = new Map<string, Read<unknown>>();
  const generations = new Map<string, number>();
  const fetchers = new Map<string, Fetcher<unknown>>();
  const watching = new Map<string, number>();
  const listeners = new Set<() => void>();
  let readings = 0;
  let recorder: ((key: string) => void) | null = null;
  const notify = () => listeners.forEach(listener => listener());
  const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

  function failureOf(error: unknown): ReadFailure {
    if (error instanceof ApiError) {
      const kind = typeof error.data?.status === 'string' ? error.data.status : null;
      return { message: error.message, kind, status: error.status };
    }
    return { message: error instanceof Error ? error.message : fallbackMessage, kind: null, status: 0 };
  }

  /** Asks for `key` unless it is already read or being read (`again`: asks anyway, keeping what was read meanwhile). */
  function ensure<T>(key: string, fetcher: Fetcher<T>, again = false, fresh = false) {
    fetchers.set(key, fetcher as Fetcher<unknown>);
    if (!again && entries.has(key)) return;
    const mine = (generations.get(key) ?? 0) + 1;
    generations.set(key, mine);
    const before = entries.get(key) as Read<T> | undefined;
    entries.set(key, { data: before?.data ?? null, failure: null, loading: true });
    void fetcher(fresh).then(data => { if (generations.get(key) === mine) entries.set(key, { data, failure: null, loading: false }); },
      error => { if (generations.get(key) === mine) entries.set(key, { data: null, failure: failureOf(error), loading: false }); })
      .finally(() => { if (generations.get(key) === mine) notify(); });
    if (again) notify();
  }

  /** Watches `key` while subscribed: asks for it if needed (after the render, never during it). */
  function watch<T>(key: string, fetcher: Fetcher<T>, listener: () => void) {
    const stop = listen(listener);
    watching.set(key, (watching.get(key) ?? 0) + 1);
    const before = entries.get(key);
    ensure(key, fetcher);
    if (entries.get(key) !== before) queueMicrotask(notify);  // now loading: the screen learns it
    return () => {
      stop();
      const left = (watching.get(key) ?? 1) - 1;
      if (left > 0) watching.set(key, left); else watching.delete(key);
    };
  }

  /** The read of `key` (null: nothing to read, e.g. a contact in discreet mode). */
  function useRead<T>(key: string | null, fetcher: Fetcher<T>): Read<T> & { reload: () => void } {
    // The fetcher depends only on what the key encodes, so the subscription changes with the key alone.
    const subscribe = useCallback((listener: () => void) => (key ? watch(key, fetcher, listener) : listen(listener)), [key]);
    const snapshot = () => (key ? entries.get(key) ?? EMPTY : EMPTY);
    const server = () => { if (key && !entries.has(key)) recorder?.(key); return snapshot(); };
    const read = useSyncExternalStore(subscribe, snapshot, server) as Read<T>;
    return { ...read, reload: () => { if (key) ensure(key, fetcher, true); } };
  }

  /** «Volver a leer»: the reads on screen are asked again at once (`fresh` is passed to their fetchers; with `keep`
   * what was read stays on screen until the new answer comes); the others, and all but `except`, are dropped. */
  function forget({ keep = false, fresh = false, except = [] as string[] } = {}) {
    for (const key of [...entries.keys()]) {
      if (except.includes(key)) continue;
      const fetcher = fetchers.get(key);
      if (!keep || !watching.get(key) || !fetcher) entries.delete(key);
      if (watching.get(key) && fetcher) ensure(key, fetcher, true, fresh);
    }
    readings++;
    notify();
  }

  return {
    failureOf, ensure, watch, useRead, forget,
    /** A new visit: whatever was read before is forgotten, without notifying (nothing is on screen yet). */
    start: () => { entries.clear(); },
    /** How many times «Volver a leer» was pressed (what depends on earlier pages starts again with it). */
    useReadings: () => useSyncExternalStore(listen, () => readings, () => readings),
    /** For tests: the keys a server render would ask (not read yet), to count the requests of a screen. */
    recordServerReads: (record: ((key: string) => void) | null) => { recorder = record; },
    has: (key: string) => entries.has(key),
    /** For tests: the read held for `key`, as the screen would get it. */
    peek: (key: string) => entries.get(key),
  };
}
