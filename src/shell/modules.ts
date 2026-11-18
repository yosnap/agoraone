import { useSyncExternalStore } from 'react';
import { getModules, putModules, type ModuleName } from '../api/core';
import { checkCentralWindow } from '../api/central';
import { checkFabricaWindow } from '../api/fabrica';

/** Which modules are on, shared by the whole screen (1.6). Until read, everything counts as on. */
let on: Partial<Record<ModuleName, boolean>> = {};
let labels: Partial<Record<ModuleName, string>> = {};
let asked = false;
const listeners = new Set<() => void>();
const publish = (next: { modules: Record<ModuleName, boolean>; labels: Record<ModuleName, string> }) => { on = next.modules; labels = next.labels; listeners.forEach(listener => listener()); };
const snapshot = () => on;
export function useModules() {
  if (!asked) { asked = true; void getModules().then(publish).catch(() => undefined); }
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot);
}
export const moduleOn = (state: Partial<Record<ModuleName, boolean>>, name: ModuleName) => state[name] !== false;
export const moduleLabels = () => labels;
export async function setModule(name: ModuleName, value: boolean) {
  publish(await putModules({ [name]: value }));
  // Central's window closes at once when no module that uses it is left on.
  if (!value && (name === 'central' || name === 'presupuestos')) void checkCentralWindow().catch(() => undefined);
  // The same for the fábrica's window when its module is turned off.
  if (!value && name === 'fabrica') void checkFabricaWindow().catch(() => undefined);
}
