import { request } from './client';

// Central's connection, through the core (/api/core/central/connection*): the key goes to the system's secret
// store and is never answered back; the screen only learns whether there is one.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type CentralScope = 'lectura' | 'presupuestos' | 'escritura';
export type CentralConnection = {
  url: string | null; hasKey: boolean; storeProblem: string | null; legacyFolder: boolean;
  transport: 'http' | 'stdio' | null; suggestedUrl: string;
};
export type CentralStatus = { version: string | null; api: string | null; scopes: CentralScope[]; runtime: 'production' | 'local' | null };

export const scopeLabels: Record<CentralScope, string> = { lectura: 'Lectura', presupuestos: 'Presupuestos', escritura: 'Escritura' };

export const getCentralConnection = () => core<CentralConnection>('/central/connection');
/** Saves the URL and, when given, a new key (without it, the saved key stays). */
export const putCentralConnection = (url: string, key?: string) => core<CentralConnection>('/central/connection', key ? { url, key } : { url }, 'PUT');
/** Forgets the key from the secret store; the URL stays, it is not secret. */
export const deleteCentralConnection = () => core<CentralConnection>('/central/connection', undefined, 'DELETE');
/** Asks Central's `estado` with what is typed (not saved yet) or, when empty, with what is saved. */
export const testCentralConnection = (url?: string, key?: string) =>
  core<CentralStatus>('/central/connection/test', { ...(url ? { url } : {}), ...(key ? { key } : {}) });

// The «Central» section, read live through the core (/api/core/central/views/*): the core picks the fixed path of
// Central's API for each view and copies only what is shown here (no paths, IPs nor tokens). Contact comes only in
// a client's record.
export type CentralViewName = 'resumen' | 'alertas' | 'pendientes' | 'clientes' | 'proyectos';
/** When Central does not answer, clients come from the last snapshot, read at `readAt`. */
export type CentralFallback = { fallback?: { readAt: string | null; problem: string } };
export type CentralSummary = { alerts: { critical: number; warning: number }; pending: number; clients: number; activeProjects: number; activeProjectsMore: boolean };
export type CentralAlert = { key: string | null; kind: string | null; level: 'critical' | 'warning'; title: string | null; detail: string | null; at: string | null };
export type CentralPending = { id: string | null; name: string | null; client: string | null; missing: string[] };
export type CentralClientRow = { id: string | null; name: string | null; company: string | null; projects: number | null; websites: number | null };
export type CentralWebsite = { id: string | null; url: string | null; label: string | null; kind: string | null; status: string | null; code: number | null;
  ms: number | null; checkedAt: string | null; sslDaysLeft: number | null };
export type CentralNote = { id: string | null; body: string | null; pinned: boolean; createdAt: string | null };
export type CentralClientProject = { id: string | null; name: string | null; kind: string | null; status: string | null; phase: string | null;
  version: string | null; repo: string | null; lastActivity: string | null };
export type CentralClientRecord = CentralFallback & { id: string | null; name: string | null; company: string | null; email: string | null; phone: string | null;
  taxId: string | null; address: string | null; projects: CentralClientProject[]; websites: CentralWebsite[]; notes: CentralNote[] };
export type CentralProjectRow = { id: string | null; name: string | null; type: string | null; kind: string | null; status: string | null; phase: string | null;
  client: string | null; version: string | null; framework: string | null; lastActivity: string | null };
export type CentralService = { id: string | null; name: string | null; environment: string | null; url: string | null; hosting: string | null;
  liveVersion: string | null; liveVersionAt: string | null };
export type CentralProjectRecord = { id: string | null; name: string | null; kind: string | null; status: string | null; phase: string | null; description: string | null;
  client: { id: string | null; name: string | null } | null; version: string | null; framework: string | null; stack: string[]; repo: string | null;
  defaultBranch: string | null; lastCommitAt: string | null; lastActivity: string | null;
  deploy: { status: string | null; hosting: string | null; version: string | null; environments: string[] };
  services: CentralService[]; websites: CentralWebsite[]; notes: CentralNote[]; auditedAt: string | null };
export type CentralLists = {
  resumen: CentralSummary; alertas: { alerts: CentralAlert[] }; pendientes: { pending: CentralPending[] };
  clientes: CentralFallback & { clients: CentralClientRow[] }; proyectos: { projects: CentralProjectRow[]; nextCursor: string | null };
};
export type ProjectFilters = { estado?: string; tipo?: string; cliente?: string; q?: string; cursor?: string };

export function getCentralView<V extends CentralViewName>(view: V, params: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return core<CentralLists[V]>(`/central/views/${view}${query ? `?${query}` : ''}`);
}
export const getCentralClient = (id: string) => core<CentralClientRecord>(`/central/views/clientes/${encodeURIComponent(id)}`);
export const getCentralProject = (id: string) => core<CentralProjectRecord>(`/central/views/proyectos/${encodeURIComponent(id)}`);

export const projectStatusLabels: Record<string, string> = { ACTIVE: 'Activo', MAINTENANCE: 'Mantenimiento', DORMANT: 'Parado', ARCHIVED: 'Archivo' };
export const projectKindLabels: Record<string, string> = { CLIENT: 'Cliente', OWN: 'Propio', TRAINING: 'Formación', EXPERIMENT: 'Experimento' };
export const deployLabels: Record<string, string> = { UNKNOWN: 'Sin indicar', NOT_DEPLOYED: 'Sin desplegar', STAGING: 'En pruebas', PRODUCTION: 'En producción', RETIRED: 'Retirado' };
