import { deleteConnector, putConnector, type Connector, type ModuleName } from '../api/core';
import { checkConnectorWindow } from '../api/connector-window';
import { refreshModules, setModule } from '../shell/modules';
import { changesFor, type Fields } from './connector-forms';

// What the card's buttons do, apart from the card so it can be checked without a screen: every call to the core is
// injectable and defaults to the real one.

export type ActionDeps = {
  put: typeof putConnector; remove: typeof deleteConnector; refresh: () => Promise<unknown>;
  /** By the connector's window label (`Connector.window`): makes the desktop app look again whether that window may stay open. */
  checkWindow: (label: string) => Promise<unknown>;
};
const real: ActionDeps = { put: putConnector, remove: deleteConnector, refresh: refreshModules, checkWindow: checkConnectorWindow };

/** After any change: the modules may follow the connection (Central turns its modules on) and its window may close. */
function afterChange(connector: Connector, deps: ActionDeps) {
  void deps.refresh().catch(() => undefined);
  if (connector.window) void deps.checkWindow(connector.window).catch(() => undefined);
}

/** «Guardar»: sends what the form says (an empty key keeps the saved one) and answers the connector as saved now. */
export async function saveConnector(connector: Connector, fields: Fields, deps: ActionDeps = real): Promise<{ next: Connector; note: string }> {
  const withKey = fields.key.trim().length > 0;
  const next = await deps.put(connector.id, changesFor(connector.kind, fields));
  afterChange(connector, deps);
  return { next, note: withKey ? 'Guardado; la clave está en el almacén de secretos del sistema.' : 'Guardado.' };
}

/** «Olvidar de verdad»: the key out of the secret store (web API) or the local settings forgotten. */
export async function forgetConnector(connector: Connector, deps: ActionDeps = real): Promise<{ next: Connector; note: string }> {
  const next = await deps.remove(connector.id);
  afterChange(connector, deps);
  return { next, note: connector.kind === 'web_api' ? 'Clave borrada del almacén de secretos.' : 'Conexión olvidada.' };
}

/** Turns a connector's module on or off (the shared module state publishes the change to the whole screen). */
export const switchModule = (name: ModuleName, value: boolean, set: typeof setModule = setModule) => set(name, value);
