import { useSyncExternalStore } from 'react';
import { getClients } from '../api/clients';
import { moduleOn, useModules } from '../shell/modules';

// The user's clients (Central's, CRMDev's and the ones kept in AgoraOne), read once for every form of the section and
// again when the Central or CRMDev module is turned on or off. A failed read (the core may still be starting) is tried again three
// times, 5 s apart, and «Volver a leer» reads it at once; any change in Trabajos › Clientes reads it again
// (`invalidateClients`). Without Central the list holds the user's own clients.
type Client = { name: string; projects: { name: string; repo?: string | null }[] };
type ClientsRead = { clients: Client[] | null; failed: boolean; retrying: boolean };  // clients null while reading
let directory: ClientsRead = { clients: null, failed: false, retrying: false };
// What was on when read (the modules of the sources): a change reads the directory again.
let readWith: boolean | string | null = null, retries = 0, generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
function fetchClients() {
  const mine = ++generation;  // only the latest read counts: an older answer never replaces a newer one
  void getClients().then(found => found.clients.map(c => ({ name: c.name, projects: c.projects.filter(p => p.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es')))
    .then(found => { if (mine === generation) directory = { clients: found, failed: false, retrying: false }; }, () => {
      if (mine !== generation) return;
      const again = retries++ < 3;
      directory = { clients: [], failed: true, retrying: again };
      if (again) timer = setTimeout(fetchClients, 5000);
    })
    .finally(() => { if (mine === generation) notify(); });
}
export function readClients(sourcesOn: boolean | string, now = false) {
  if (!now && readWith === sourcesOn) return;
  clearTimeout(timer);
  retries = 0;
  readWith = sourcesOn;
  directory = { clients: null, failed: false, retrying: false };
  if (now) notify();
  fetchClients();
}
export function useClients(): ClientsRead & { reread: () => void } {
  const modules = useModules();
  const on = `${moduleOn(modules, 'central')}-${moduleOn(modules, 'crmdev')}`;
  readClients(on);
  const read = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => directory);
  return { ...read, reread: () => readClients(on, true) };
}

/** Reads the clients again for every list on screen: after a client is created, changed, deleted or linked. */
export function invalidateClients() {
  if (readWith !== null) readClients(readWith, true);
}
/** What the lists see now (for tests and non-React readers). */
export const currentClients = () => directory;
