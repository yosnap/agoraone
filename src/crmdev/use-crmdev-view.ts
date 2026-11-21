import type { CrmdevPage } from '../api/crmdev';
import { createReadStore, readKey, type Fetcher, type Read, type ReadFailure } from '../ui/read-store';

// What the «CRMDev» section has read, shared by its tabs and records (the store of src/ui/read-store.ts): each read is
// asked once, when it is first on screen, and kept while the section lives (the core also keeps each list for 60 s,
// and CRMDev allows only 10 requests every 10 s). «Volver a leer» asks CRMDev now (skipping the core's cache) for
// what is on screen, which stays visible until the new answer comes, so an open record does not close.

export type CrmdevFailure = ReadFailure;
export type CrmdevRead<T> = Read<T>;

/** The store of the section; exported for the tests. */
export const crmdevStore = createReadStore('No se pudo leer CRMDev.');
export const failureOf = crmdevStore.failureOf;
export { readKey };

/** The read of `key` (null: nothing to read, e.g. a contact in discreet mode), asked once it is on screen. */
export function useCrmdevRead<T>(key: string | null, fetcher: Fetcher<T>): CrmdevRead<T> & { reload: () => void } {
  return crmdevStore.useRead(key, fetcher);
}

/** «Volver a leer»: asks CRMDev again, now, for everything on screen. */
export const readAgain = () => crmdevStore.forget({ keep: true, fresh: true });
/** Whether a «Volver a leer» is still waiting for its answers. */
export const useRereading = () => crmdevStore.useRereading();

/** A fresh start each time the section opens (harmless if called twice: it only empties the store). */
export const startCrmdev = (except: string[] = []) => crmdevStore.start(except);

export type CrmdevTabName = 'proyectos' | 'tareas' | 'tickets' | 'clientes' | 'central';
/** The tabs of the section, in order; each one reads only its own list when opened. */
export const crmdevTabs: { id: CrmdevTabName; label: string }[] = [
  { id: 'proyectos', label: 'Proyectos' }, { id: 'tareas', label: 'Tareas' }, { id: 'tickets', label: 'Tickets' }, { id: 'clientes', label: 'Clientes' },
  { id: 'central', label: 'Desde Central' },
];

// The tab another section asks the CRMDev section to open with (the Resumen's «Ver lo pendiente»), taken once.
let requestedTab: CrmdevTabName | null = null;
export const openCrmdevTab = (tab: CrmdevTabName) => { requestedTab = tab; };
export const takeCrmdevTab = (): CrmdevTabName => { const tab = requestedTab ?? 'proyectos'; requestedTab = null; return tab; };

/** What a full list holds, said truthfully: CRMDev has no pages, so only 100 rows come and the rest is only in CRMDev. */
export function orderNote(page: Pick<CrmdevPage<unknown>, 'more' | 'order' | 'limit'>): string | null {
  if (!page.more) return null;
  return page.order === 'primeros'
    ? `Los ${page.limit} primeros (por antigüedad): CRMDev no da más de ${page.limit} y el resto solo se ve allí.`
    : `Los ${page.limit} más recientes: CRMDev no da más de ${page.limit} y el resto solo se ve allí.`;
}

/** The distinct, non-empty names of some rows, sorted as in Spanish. */
export const namesOf = (values: (string | null | undefined)[]) =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) => a.localeCompare(b, 'es'));

const clock = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Madrid' });
const dayOf = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });

/** «Leído de CRMDev a las 10:05:12» (Madrid) for the oldest of some answers, so nothing looks newer than it is; the
 * day too when it is not today; empty when no time is known. */
export function readAtLabel(times: (string | null | undefined)[], now = new Date()) {
  const known = times.map(t => (t ? new Date(t) : null)).filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()));
  if (!known.length) return '';
  const oldest = new Date(Math.min(...known.map(d => d.getTime())));
  const day = dayOf.format(oldest) === dayOf.format(now) ? '' : ` del ${dayOf.format(oldest)}`;
  return `Leído de CRMDev a las ${clock.format(oldest)}${day}`;
}
