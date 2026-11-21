import { useSyncExternalStore } from 'react';
import { getOrcaProjects, type OrcaProject } from '../api/core';

/** Central projects whose repository is already in Orca, shared by every button and read at most once a minute
 * while it works (a failure is read again on the next visit). Empty when Orca is not installed or its module is
 * off, so no button shows; `problem` says why Orca could not be read. */
type State = { projects: OrcaProject[]; problem: string | null };
let state: State = { projects: [], problem: null };
let readAt = 0;
let reading = false;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach(listener => listener());

const read = () => {
  if (reading || Date.now() - readAt < 60_000) return;
  reading = true;
  getOrcaProjects()
    .then(found => { state = found; readAt = found.problem ? 0 : Date.now(); })
    .catch(failure => { state = { projects: [], problem: failure instanceof Error ? failure.message : 'No se pudo leer Orca.' }; readAt = 0; })
    .finally(() => { reading = false; tell(); });
};

/** After the module is switched on or off in Ajustes: off hides the buttons at once, on reads again. */
export function refreshOrcaProjects(on: boolean) {
  readAt = 0;
  if (!on) { state = { projects: [], problem: null }; tell(); return; }
  if (listeners.size) read();
}

export function useOrcaState(): State {
  return useSyncExternalStore(listener => { listeners.add(listener); read(); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
export const useOrcaProjects = () => useOrcaState().projects;

/** The projects of one client that can be taken to Orca. */
export const clientProjects = (all: OrcaProject[], client: string | null | undefined) => all.filter(p => p.client === client);
