import { request } from './client';

// Changes to Central from AgoraOne's own views, through the core (/api/core/central/write/*): first the exact change
// (before and after, checked against what Central has now) with a single-use token, then «Guardar en Central» sends
// exactly that, once. Never anything that deletes.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type ClientField = 'name' | 'company' | 'email' | 'phone' | 'taxId' | 'address';
export type ChangeRequest =
  | { kind: 'cliente'; id: string; revision: string; changes: Partial<Record<ClientField, string | null>> }
  | { kind: 'proyecto'; id: string; revision: string; changes: { status?: string; statusLocked?: true; phase?: string | null } }
  | { kind: 'fase'; id: string; phaseId: string; revision: string; changes: { status?: string; dueDate?: string | null } }
  | { kind: 'nota'; target: 'cliente' | 'proyecto'; id: string; body: string }
  | { kind: 'cliente-nuevo'; localId: number };
export type ChangeRow = { field: string; label: string; before: string | null; after: string | null; emptied: boolean };
export type ChangePreview = { token: string; kind: ChangeRequest['kind']; title: string; rows: ChangeRow[]; notes: string[]; warnings: string[] };
/** What Central has now of a record, after a conflict. */
export type CurrentRow = { field: string; label: string; value: string | null };
export type ChangeDone = { done: true; kind: ChangeRequest['kind']; title: string; warning?: string; repeated?: boolean };
/** Whether the saved key may change Central's records and quote phases; `problem` says how to get such a key. */
export type WritePermissions = { central: boolean; quotes: boolean; problem: string | null };

export const getWritePermissions = () => core<WritePermissions>('/central/write/permissions');
export const previewCentralChange = (change: ChangeRequest) => core<ChangePreview>('/central/write/preview', change);
export const confirmCentralChange = (token: string) => core<ChangeDone>('/central/write/confirm', { token });
