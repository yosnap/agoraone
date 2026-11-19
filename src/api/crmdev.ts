import { request } from './client';

// CRMDev, through the core (/api/core/crmdev/*): the connection lives in the connector «crmdev» (its key only in the
// system's secret store) and each view maps to one tool of a closed list in the core, read-only. Everything here is
// data from CRMDev: shown as text, never acted upon. Lists carry no assignee's or guest's address.
const core = <T>(path: string) => request<T>(`/core${path}`);
/** When CRMDev gave an answer (ISO, UTC): a cached one keeps its own time. */
type ReadAt = { readAt: string | null };
/** The query of a read: its filters and, for «Volver a leer», `fresco=1` (CRMDev is asked now, not the core's cache). */
const query = (params: Record<string, string | undefined>, fresh: boolean) => {
  const text = new URLSearchParams(Object.entries({ ...params, fresco: fresh ? '1' : undefined })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')).toString();
  return text ? `?${text}` : '';
};

/** What «Probar» answers: the scope of an organization key, the tools of the closed list CRMDev offers and those that
 * also depend on a module of the plan (tickets), only known when their view is opened. */
export type CrmdevProbe = { version: null; scopes: 'organizacion'[]; tools: string[]; unverified?: string[] };
export const isCrmdevProbe = (value: unknown): value is CrmdevProbe =>
  typeof value === 'object' && value !== null && Array.isArray((value as CrmdevProbe).tools) && Array.isArray((value as CrmdevProbe).scopes);

export type CrmdevProject = { id: string | null; name: string | null; status: string | null; progress: number | null; type: string | null; deadline: string | null };
export type CrmdevTask = { id: string | null; title: string | null; description: string | null; status: string | null; priority: string | null;
  dueDate: string | null; assignee: { id: string | null; name: string | null } | null; project: string | null };
export type CrmdevTicket = { id: string | null; title: string | null; description: string | null; status: string | null; priority: string | null;
  category: string | null; requester: string | null; client: string | null; project: string | null; createdAt: string | null; updatedAt: string | null };
export type CrmdevClient = { id: string | null; name: string | null; company: string | null; status: string | null };
export type CrmdevMember = { id: string | null; name: string | null; role: string | null };
export type CrmdevHours = { project: string | null; total: string | null; entries: number | null;
  rows: { task: string | null; user: string | null; minutes: number | null }[];
  /** Only the first 500 rows are here; `total` and `entries` are CRMDev's for the whole project. */
  cut: boolean } & ReadAt;

export type CrmdevLists = { proyectos: CrmdevProject; tareas: CrmdevTask; tickets: CrmdevTicket; clientes: CrmdevClient; miembros: CrmdevMember };
export type CrmdevViewName = keyof CrmdevLists;
/** The filters each view takes (the core refuses any other). */
export type CrmdevFilters = { proyectos: { estado?: string }; tareas: { estado?: string; proyecto?: string }; tickets: { estado?: string; cliente?: string };
  clientes: { estado?: string }; miembros: Record<string, never> };
/** At most 100 rows; `more` when the list is full (CRMDev has no pages: the rest is only seen in CRMDev). `order` says
 * which rows a full list holds: the most recent ones, or for members the 100 who joined first. */
export type CrmdevPage<T> = { items: T[]; limit: number; more: boolean; order: 'recientes' | 'primeros' } & ReadAt;

export function getCrmdevView<V extends CrmdevViewName>(view: V, filters: CrmdevFilters[V] = {} as CrmdevFilters[V], fresh = false) {
  return core<CrmdevPage<CrmdevLists[V]>>(`/crmdev/views/${view}${query(filters, fresh)}`);
}

export const getCrmdevHours = (projectId: string, fresh = false) =>
  core<CrmdevHours>(`/crmdev/proyectos/${encodeURIComponent(projectId)}/horas${query({}, fresh)}`);

/** A client's record with its address, from the same list (and state filter) as the list on screen, since CRMDev has
 * no read by id. Hidden, and not asked, in discreet mode. */
export type CrmdevClientRecord = CrmdevClient & { email: string | null } & ReadAt;
export const getCrmdevClient = (clientId: string, estado?: string, fresh = false) =>
  core<CrmdevClientRecord>(`/crmdev/clientes/${encodeURIComponent(clientId)}${query({ estado }, fresh)}`);

// CRMDev's own web, in a window of the desktop app (/api/core/crmdev/window*): only pages of a closed list of the
// saved CRMDev address, named without the language (the core adds `/es/`; a ticket lives under `soporte/tickets`).
export type CrmdevWindowPage = 'panel' | 'proyectos' | 'tareas' | 'clientes' | 'soporte' | `proyectos/${string}` | `clientes/${string}`
  | `tickets/${string}`;
