import { useSyncExternalStore } from 'react';
import { getModules, putModules, type ModuleName, type ModulesState } from '../api/core';
import { checkConnectorWindow, closeConnectorWindow } from '../api/connector-window';

/** Which modules are on, shared by the whole screen (1.6). Until read, everything counts as on. */
let on: Partial<Record<ModuleName, boolean>> = {};
let labels: Partial<Record<ModuleName, string>> = {};
let owners: Partial<Record<ModuleName, string>> | null = null;
let windows: Partial<Record<ModuleName, string>> | null = null;
let read = false;
let asked = false;
const listeners = new Set<() => void>();
const publish = (next: ModulesState) => {
  on = next.modules; labels = next.labels; owners = next.owners ?? null; windows = next.windows ?? null; read = true;
  listeners.forEach(listener => listener());
};
const snapshot = () => on;
export function useModules() {
  if (!asked) {
    asked = true;
    // Unreadable: everything stays on and the screens stop waiting (with nothing said about owners).
    void getModules().then(publish).catch(() => { read = true; on = { ...on }; listeners.forEach(listener => listener()); });
  }
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
/** Reads the modules again: saving a connection may turn on the modules that follow it. */
export const refreshModules = () => getModules().then(publish);
export const moduleOn = (state: Partial<Record<ModuleName, boolean>>, name: ModuleName) => state[name] !== false;
export const moduleLabels = () => labels;
/** The connector that holds each module's switch, or null until read (or with an older core that does not say). */
export const moduleOwners = () => owners;
/** Whether the modules have been read once. */
export const modulesRead = () => read;
/** Before the modules are read, or with an older core that does not say which windows there are. */
const KNOWN_WINDOWS = ['central', 'crmdev', 'fabrica'];
/** Discreet mode turned on: every connector's window closes (it would keep showing what discreet mode hides). The
 * labels are those the core gives for the modules (`Connector.window`). */
export function closeConnectorWindows(close: (label: string) => Promise<unknown> = closeConnectorWindow) {
  const labels = windows ? [...new Set(Object.values(windows))] : KNOWN_WINDOWS;
  return Promise.all(labels.map(label => close(label).catch(() => undefined)));
}
export async function setModule(name: ModuleName, value: boolean) {
  publish(await putModules({ [name]: value }));
  // The window of the connector that holds the module (`Connector.window`, as the core says) closes at once when no
  // module that uses it is left on: Central with Presupuestos, CRMDev, the fábrica…
  const label = windows?.[name];
  if (!value && label) void checkConnectorWindow(label).catch(() => undefined);
}
