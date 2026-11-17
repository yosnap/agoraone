import { useSyncExternalStore } from 'react';
import { getCodingSessions, type CodingSession } from '../api/core';

/** The coding sessions for the city's code workshop, read every 15 s while someone shows them and the window is
 * visible. Only metadata from the core (never what was said). A failed read keeps nothing old as if current. */
const EVERY = 15_000;
let sessions: CodingSession[] | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function read() {
  if (typeof document !== 'undefined' && document.hidden) return;
  try { sessions = (await getCodingSessions()).sessions; } catch { sessions = null; }
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

export const useCodingSessions = () => useSyncExternalStore(subscribe, () => sessions);

/** Who is at the workshop now: working, running a tool or waiting for your permission, or waiting for you (the
 * last 30 minutes, as the core counts them); the most recent first. Paused sessions are not shown. */
export const atWork = (all: CodingSession[] | null) => (all ?? []).filter(s => s.state !== 'paused');
