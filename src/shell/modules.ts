import { useSyncExternalStore } from 'react';
import { getModules, putModules, type ModuleName, type ModulesState } from '../api/core';
import { checkCentralWindow } from '../api/central';
import { checkFabricaWindow } from '../api/fabrica';

/** Which modules are on, shared by the whole screen (1.6). Until read, everything counts as on. */
let on: Partial<Record<ModuleName, boolean>> = {};
let labels: Partial<Record<ModuleName, string>> = {};
let owners: Partial<Record<ModuleName, string>> | null = null;
let read = false;
let asked = false;
const listeners = new Set<() => void>();
const publish = (next: ModulesState) => {
  on = next.modules; labels = next.labels; owners = next.owners ?? null; read = true;
  listeners.forEach(listener => listener());
};
const snapshot = () => on;
export function useModules() {
  if (!asked) {
    asked = true;
    // Unreadable: everything stays on and the screens stop waiting (with nothing said about owners).
    void getModules().then(publish).catch(() => { read = true; on = { ...on }; listeners.forEach(listener => listener()); });
  }
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot);
}
/** Reads the modules again: saving a connection may turn on the modules that follow it. */
export const refreshModules = () => getModules().then(publish);
export const moduleOn = (state: Partial<Record<ModuleName, boolean>>, name: ModuleName) => state[name] !== false;
export const moduleLabels = () => labels;
/** The connector that holds each module's switch, or null until read (or with an older core that does not say). */
export const moduleOwners = () => owners;
/** Whether the modules have been read once. */
export const modulesRead = () => read;
export async function setModule(name: ModuleName, value: boolean) {
  publish(await putModules({ [name]: value }));
  // Central's window closes at once when no module that uses it is left on.
  if (!value && (name === 'central' || name === 'presupuestos')) void checkCentralWindow().catch(() => undefined);
  // The same for the fábrica's window when its module is turned off.
  if (!value && name === 'fabrica') void checkFabricaWindow().catch(() => undefined);
}
