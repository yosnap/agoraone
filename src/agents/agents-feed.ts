import { useSyncExternalStore } from 'react';
import { getHermesActivity, getHermesCatalog, getHermesWork } from '../api/client';
import { getWatsonActivity, type WatsonActivity } from '../api/core';
import type { HermesActivity } from '../../shared/hermes-activity';
import type { HermesCatalog } from '../../shared/hermes-catalog';
import type { HermesWork } from '../../shared/hermes-work';

/** What the «Agentes» section shows, read every 15 s while it is on screen and the window is visible (paused
 * otherwise). A source that fails is left out instead of showing its old data as current. */
export type Feed = { catalog: HermesCatalog | null; activity: HermesActivity | null; work: HermesWork | null; watson: WatsonActivity | null;
  readAt: number | null; failed: string[] };

const EVERY = 15_000;
let feed: Feed = { catalog: null, activity: null, work: null, watson: null, readAt: null, failed: [] };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;

async function read() {
  if (reading || (typeof document !== 'undefined' && document.hidden)) return;
  reading = true;
  const [catalog, activity, work, watson] = await Promise.allSettled([getHermesCatalog(), getHermesActivity(), getHermesWork(), getWatsonActivity()]);
  const value = <T,>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null;
  const failed = [['Hermes', catalog], ['actividad de Hermes', activity], ['trabajos de Hermes', work], ['Watson', watson]]
    .filter(([, result]) => (result as PromiseSettledResult<unknown>).status === 'rejected').map(([name]) => name as string);
  feed = { catalog: value(catalog) ?? feed.catalog, activity: value(activity), work: value(work), watson: value(watson), readAt: Date.now(), failed };
  reading = false;
  listeners.forEach(listener => listener());
}
const onVisible = () => { if (!document.hidden) void read(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void read();
    timer = setInterval(() => void read(), EVERY);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export const useAgentsFeed = () => useSyncExternalStore(subscribe, () => feed);
export const refreshAgents = () => read();
