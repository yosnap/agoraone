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
