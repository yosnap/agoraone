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
  dueDate: string | null; assignee: { id: string | null; name: string | null } | null; project: string | null; projectId?: string | null };
export type CrmdevTicket = { id: string | null; title: string | null; description: string | null; status: string | null; priority: string | null;
  category: string | null; requester: string | null; client: string | null; project: string | null; projectId?: string | null; createdAt: string | null; updatedAt: string | null };
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

// Changes to CRMDev, through the core (/api/core/crmdev/write/*): first the exact change (before and after, read from
// CRMDev now) with a single-use token, then «Guardar en CRMDev» sends exactly that, once. The screen never names a tool
// and nothing deletes. `anyway` («Crear de todos modos») only after a creation whose answer never came. `list` is the filter of the list the record was shown in, so the core reads it from the same one.
const send = <T>(path: string, body: unknown) => request<T>(`/core${path}`, body);
export type CrmdevTaskValues = { title: string; description?: string; projectId?: string; assigneeId?: string; status?: string; priority?: string;
  dueDate?: string };
export type CrmdevClientValues = { name: string; email?: string; company?: string; phone?: string; status?: string };
export type CrmdevChangeRequest =
  | { kind: 'tarea-nueva'; values: CrmdevTaskValues; anyway?: true }
  | { kind: 'tarea'; id: string; list?: { estado?: string; proyecto?: string };
    changes: { title?: string; description?: string | null; status?: string; priority?: string } }
  | { kind: 'proyecto'; id: string; list?: { estado?: string }; changes: { name?: string; status?: string; progress?: number } }
  | { kind: 'cliente-nuevo'; values: CrmdevClientValues; anyway?: true }
  /** «Crear en CRMDev» of a client kept only in AgoraOne: its own data as it is, and the state chosen. */
  | { kind: 'cliente-desde-local'; localId: number; status?: string; anyway?: true }
  | { kind: 'cliente'; id: string; list?: { estado?: string }; changes: { name?: string; email?: string; company?: string | null; status?: string } }
  | { kind: 'ticket'; id: string; list?: { estado?: string; cliente?: string }; changes: { status?: string; priority?: string; category?: string } };
export type CrmdevChangeRow = { field: string; label: string; before: string | null; after: string | null; emptied: boolean };
export type CrmdevChangePreview = { token: string; kind: CrmdevChangeRequest['kind']; title: string; rows: CrmdevChangeRow[]; notes: string[]; warnings: string[] };
export type CrmdevChangeDone = { done: true; kind: CrmdevChangeRequest['kind']; title: string; warning?: string; repeated?: boolean };

export const previewCrmdevChange = (change: CrmdevChangeRequest) => send<CrmdevChangePreview>('/crmdev/write/preview', change);
export const confirmCrmdevChange = (token: string) => send<CrmdevChangeDone>('/crmdev/write/confirm', { token });

/** «Actualizar» the clients the directory uses: CRMDev is read now (at most 1000; `truncated` when it gave that many). */
export const refreshCrmdevClients = () => send<{ count: number; fetchedAt: string; truncated: boolean }>('/crmdev/clients/refresh', {});

/** An organization of CRMDev: its key fixes it and CRMDev does not say its name, so the user names it here. */
export type CrmdevOrg = { id: string; name: string; hasKey: boolean; clients: number | null; projects: number | null; fetchedAt: string | null };
export type CrmdevOrgs = { orgs: CrmdevOrg[]; added?: string; warning?: string };
export const getCrmdevOrgs = () => core<CrmdevOrgs>('/crmdev/orgs');
export const addCrmdevOrg = (name: string, key: string) => send<CrmdevOrgs>('/crmdev/orgs', { name, key });
export const changeCrmdevOrg = (id: string, change: { name?: string; key?: string }) =>
  request<CrmdevOrgs>(`/core/crmdev/orgs/${encodeURIComponent(id)}`, change, 'PATCH');
export const testCrmdevOrg = (id: string) => send<{ org: string; tools: string[] }>(`/crmdev/orgs/${encodeURIComponent(id)}/test`, {});
export const forgetCrmdevOrg = (id: string) => request<CrmdevOrgs>(`/core/crmdev/orgs/${encodeURIComponent(id)}`, undefined, 'DELETE');
