import { request } from './client';
import { deleteConnector, getConnector, putConnector, testConnector, type Connector } from './core';
import { checkConnectorWindow, closeConnectorWindow, openConnectorInBrowser, openConnectorLink, openConnectorWindow, windowExternalLink,
  type WindowLink } from './connector-window';

// Central's connection, through the core's connector «central» (/api/core/connectors/central): the key goes to the
// system's secret store and is never answered back; the screen only learns whether there is one.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type CentralScope = 'lectura' | 'presupuestos' | 'escritura';
export type CentralConnection = {
  url: string | null; hasKey: boolean; storeProblem: string | null; legacy: boolean;
  transport: 'http' | null; suggestedUrl: string;
};
export type CentralStatus = { version: string | null; api: string | null; scopes: CentralScope[]; runtime: 'production' | 'local' | null };

export const scopeLabels: Record<CentralScope, string> = { lectura: 'Lectura', presupuestos: 'Presupuestos', escritura: 'Escritura' };

const SUGGESTED_URL = 'https://central.example.com';

/** Central's connector, in the shape Settings › Central and the «Central» section read. Connected means a URL and a
 * key saved, whatever its status says (saved now; checked statuses such as «responding» later). */
export function centralConnection(connector: Pick<Connector, 'state' | 'hint'>): CentralConnection {
  const { status, configured, storeProblem } = connector.state;
  const url = configured.url ?? null;
  const hasKey = configured.hasKey === true;
  return { url, hasKey, storeProblem, legacy: status === 'legacy', transport: url && hasKey ? 'http' : null, suggestedUrl: connector.hint ?? SUGGESTED_URL };
}

export const getCentralConnection = () => getConnector('central').then(centralConnection);
/** Saves the URL and, when given, a new key (without it, the saved key stays). */
export const putCentralConnection = (url: string, key?: string) => putConnector('central', key ? { url, key } : { url }).then(centralConnection);
/** Forgets the key from the secret store; the URL stays, it is not secret. */
export const deleteCentralConnection = () => deleteConnector('central').then(centralConnection);
/** Asks Central's `estado` with what is typed (not saved yet) or, when empty, with what is saved. */
export const testCentralConnection = (url?: string, key?: string) =>
  testConnector<CentralStatus>('central', { ...(url ? { url } : {}), ...(key ? { key } : {}) });

// The «Central» section, read live through the core (/api/core/central/views/*): the core picks the fixed path of
// Central's API for each view and copies only what is shown here (no paths, IPs nor tokens). Contact comes only in
// a client's record.
export type CentralViewName = 'resumen' | 'alertas' | 'pendientes' | 'clientes' | 'proyectos' | 'webs' | 'servidores' | 'agenda';
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
  taxId: string | null; address: string | null; projects: CentralClientProject[]; websites: CentralWebsite[]; notes: CentralNote[];
  /** The version Central gave this record to change it; null: it cannot be changed from here (old Central or a snapshot). */
  revision: string | null;
  /** The data exactly as Central keeps it (not scrubbed nor cut), only for the edit form; null in a snapshot. */
  editable: Record<'name' | 'company' | 'email' | 'phone' | 'taxId' | 'address', string | null> | null };
export type CentralProjectRow = { id: string | null; name: string | null; type: string | null; kind: string | null; status: string | null; phase: string | null;
  client: string | null; version: string | null; framework: string | null; lastActivity: string | null };
export type CentralService = { id: string | null; name: string | null; environment: string | null; url: string | null; hosting: string | null;
  liveVersion: string | null; liveVersionAt: string | null };
export type CentralProjectRecord = { id: string | null; name: string | null; kind: string | null; status: string | null; phase: string | null; description: string | null;
  client: { id: string | null; name: string | null } | null; version: string | null; framework: string | null; stack: string[]; repo: string | null;
  statusLocked: boolean; revision: string | null;
  defaultBranch: string | null; lastCommitAt: string | null; lastActivity: string | null;
  deploy: { status: string | null; hosting: string | null; version: string | null; environments: string[] };
  services: CentralService[]; websites: CentralWebsite[]; notes: CentralNote[]; auditedAt: string | null };
/** A monitored website of the «Webs» tab: its last check, as Central lists it. */
export type CentralWebsiteRow = { id: string | null; url: string | null; kind: string | null; client: string | null; status: string | null;
  code: number | null; ms: number | null; checkedAt: string | null };
/** green = bien, amber = mirar, red = actuar, grey = sin dato (Central's levels). */
export type CentralLevel = 'green' | 'amber' | 'red' | 'grey';
export type CentralServerProject = { projectId: string | null; project: string | null; service: string | null; environment: string | null; url: string | null;
  containers: { name: string | null; state: string | null }[] };
export type CentralServerRow = { id: string | null; name: string | null; provider: string | null; panel: string | null; status: CentralLevel; error: string | null;
  lastOkAt: string | null; cpu: number | null; memory: number | null; disk: number | null;
  services: { ok: number | null; total: number | null; down: string[] } | null;
  protection: { done: number | null; total: number | null; level: CentralLevel } | null; projects: CentralServerProject[] };
type Card<T> = { level: CentralLevel } & T;
export type CentralServerCards = Partial<{
  cpu: Card<{ pct: number | null }>; memory: Card<{ pct: number | null }>; disk: Card<{ pct: number | null }>;
  webs: Card<{ down: number | null; slow: number | null }>; certificate: Card<{ days: number | null }>; sessions: Card<{ count: number | null }>;
  attempts: Card<{ hour: number | null; day: number | null }>; banned: Card<{ now: number | null }>; ports: Card<{ odd: number[]; exposed: number[] }>;
  maintenance: Card<{ pending: number | null; security: number | null; reboot: boolean }>;
  services: Card<{ ok: number | null; total: number | null; down: string[]; stopped: string[] }>;
}>;
export type CentralServerRecord = CentralServerRow & { cards: CentralServerCards; readAt: string | null; root: boolean; domains: string[] | null;
  containers: { name: string | null; kind: string | null; state: string | null; detail: string | null }[];
  checks: { key: string | null; ok: boolean | null; detail: string | null; fix: string | null }[] };
export type CentralEvent = { summary: string | null; calendar: string | null; start: string | null; end: string | null; allDay: boolean;
  location: string | null; client: string | null; project: string | null };
export type CentralLists = {
  resumen: CentralSummary; alertas: { alerts: CentralAlert[] }; pendientes: { pending: CentralPending[] };
  clientes: CentralFallback & { clients: CentralClientRow[] }; proyectos: { projects: CentralProjectRow[]; nextCursor: string | null };
  webs: { websites: CentralWebsiteRow[] }; servidores: { servers: CentralServerRow[] }; agenda: { events: CentralEvent[]; errors: string[] };
};
export type ProjectFilters = { estado?: string; tipo?: string; cliente?: string; q?: string; cursor?: string };

export function getCentralView<V extends CentralViewName>(view: V, params: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return core<CentralLists[V]>(`/central/views/${view}${query ? `?${query}` : ''}`);
}
export const getCentralClient = (id: string) => core<CentralClientRecord>(`/central/views/clientes/${encodeURIComponent(id)}`);
export const getCentralProject = (id: string) => core<CentralProjectRecord>(`/central/views/proyectos/${encodeURIComponent(id)}`);
export const getCentralServer = (id: string) => core<CentralServerRecord>(`/central/views/servidores/${encodeURIComponent(id)}`);

export const projectStatusLabels: Record<string, string> = { ACTIVE: 'Activo', MAINTENANCE: 'Mantenimiento', DORMANT: 'Parado', ARCHIVED: 'Archivo' };
export const projectKindLabels: Record<string, string> = { CLIENT: 'Cliente', OWN: 'Propio', TRAINING: 'Formación', EXPERIMENT: 'Experimento' };
export const deployLabels: Record<string, string> = { UNKNOWN: 'Sin indicar', NOT_DEPLOYED: 'Sin desplegar', STAGING: 'En pruebas', PRODUCTION: 'En producción', RETIRED: 'Retirado' };
export const webKindLabels: Record<string, string> = { CLIENT: 'Cliente', OWN: 'Propia', CENTRAL: 'Centralizada' };
export const levelLabels: Record<CentralLevel, string> = { green: 'Bien', amber: 'Mirar', red: 'Actuar', grey: 'Sin dato' };

// Central's own web, in a window of the desktop app (/api/core/central/window*): only pages of a closed list of the
// saved Central address. The user signs in there with Central's login; AgoraOne's key never goes to that window.
export type CentralPage = '' | 'ajustes' | 'webs' | 'servidores' | 'alertas' | 'correo' | `clientes/${string}` | `proyectos/${string}`
  | `servidores/${string}` | `presupuestos/${string}`;
/** Opens the page in Central's window; 409 `no_window` when AgoraOne runs in a browser tab (no desktop app). */
export const openCentralWindow = (ruta: CentralPage) => openConnectorWindow('central', ruta);
/** The same page in the system's browser. */
export const openCentralInBrowser = (ruta: CentralPage) => openConnectorInBrowser('central', ruta);
/** A link of Central to another site (http or https; the screen warns first about http), in the system's browser. */
export const openCentralLink = (url: string) => openConnectorLink('central', url);
/** Closes Central's window (discreet mode turned on); nothing happens without the desktop app. */
export const closeCentralWindow = () => closeConnectorWindow('central');
/** Makes the desktop app look again at once whether the window may stay (module and address changed). */
export const checkCentralWindow = () => checkConnectorWindow('central');

/** A link of Central to another site, as the desktop app hands it over (see `windowExternalLink`). */
export type CentralLink = WindowLink;
export const centralExternalLink = windowExternalLink;
