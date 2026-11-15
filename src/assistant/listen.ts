import { useSyncExternalStore } from 'react';

/** «Listen now» requests (1.5): from the global shortcut ⌃⌥W (the desktop app sends `agora:listen`) and, later,
 * from «Oye Watson». Each request bumps a counter; Watson's large microphone starts (or stops and sends) when
 * it changes. */
let requests = 0;
const listeners = new Set<() => void>();
export function requestListen() { requests += 1; listeners.forEach(listener => listener()); }
export const useListenRequests = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => requests);
