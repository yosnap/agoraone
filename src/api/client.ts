export type DocumentSource = { id: string; title: string; revision: string };
export type LibraryDocument = DocumentSource & { content: string };
export type Message = { role: 'user' | 'assistant'; content: string; sources?: DocumentSource[]; identity?: { profileId: string; files: { name: string; revision: string }[] } };
export type Conversation = { id: string; messages: Message[]; profileId?: string };
export type Status = { state: string; detail: string; csrf: string };
import type { HermesCatalog, HermesProfile, HermesFile } from '../../shared/hermes-catalog';
import type { McpTools } from '../../shared/hermes-catalog';
import type { HermesActivity } from '../../shared/hermes-activity';
let csrf = '';
async function request<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Agora-CSRF': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'El backend no está disponible.');
  return data;
}
export async function getStatus() { const status = await request<Status>('/status'); csrf = status.csrf; return status; }
export const getHermesCatalog = () => request<HermesCatalog>('/hermes/catalog');
export const getHermesActivity = () => request<HermesActivity>('/hermes/activity');
export type ProfileLimits = Record<'MEMORY.md' | 'USER.md', number>;
export const getHermesProfile = (id: string, reveal = false) => request<{ profile: HermesProfile; files: HermesFile[]; limits: ProfileLimits }>(`/hermes/profiles/${encodeURIComponent(id)}${reveal ? '?reveal=1' : ''}`);
/** Writes a real Hermes identity file; `revision` is the version the user edited (null when the file is new). */
export const saveProfileFile = (id: string, name: HermesFile['name'], edit: { content?: string; entries?: string[]; revision: string | null; revealed?: boolean }) =>
  request<{ revision: string; backup: string | null }>(`/hermes/profiles/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`, edit, 'PUT');
export type VaultNote = { id: string; title: string; folder: string; bytes: number; modifiedAt: string; readable: boolean };
export type VaultListing = { vault: { id: string; name: string }; truncated: boolean; notes: VaultNote[] };
export const listVaultNotes = (vaultId: string) => request<VaultListing>(`/hermes/vaults/${encodeURIComponent(vaultId)}/notes`);
export const readVaultNote = (vaultId: string, noteId: string, reveal = false) => request<VaultNote & { content: string; revision: string; hidden: number }>(`/hermes/vaults/${encodeURIComponent(vaultId)}/notes/${encodeURIComponent(noteId)}${reveal ? '?reveal=1' : ''}`);
export const searchVault = (vaultId: string, query: string) => request<{ results: { id: string; title: string; folder: string; snippet: string }[]; truncated: boolean }>(`/hermes/vaults/${encodeURIComponent(vaultId)}/search?q=${encodeURIComponent(query)}`);
export const getMcpTools = (profileId: string, serverId: string) => request<McpTools>(`/hermes/profiles/${encodeURIComponent(profileId)}/mcp/${encodeURIComponent(serverId)}/tools`);
export const createConversation = (profileId?: string) => request<Conversation>('/conversations', profileId ? { profileId } : { agent: 'luma', context: 'library-lobby' });
export const getConversation = (id: string) => request<Conversation>(`/conversations/${encodeURIComponent(id)}`);
export type ChatProgress = { type: 'status'; stage: 'starting' | 'generating' } | { type: 'delta'; text: string };
export async function sendMessage(id: string, message: string, documentId?: string, onProgress?: (event: ChatProgress) => void): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-Agora-CSRF': csrf },
    body: JSON.stringify({ message, documentId }),
  });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'No se pudo enviar.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No se pudo leer la respuesta.');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'done') return event.conversation;
        if (event.type === 'status' || event.type === 'delta') onProgress?.(event);
      }
      if (done) throw new Error('La conexión se interrumpió. Recarga la conversación para comprobar si se completó.');
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export type CatalogEntry = { id: string; title: string; kind: 'example' | 'private' };
export const listDocuments = () => request<{ documents: CatalogEntry[] }>('/library/documents');
export const readDocument = (id: string) => request<LibraryDocument>(`/library/documents/${encodeURIComponent(id)}`);
export const renameDocument = (id: string, title: string) => request<LibraryDocument>(`/library/documents/${encodeURIComponent(id)}`, { title }, 'PATCH');
export const deleteDocument = (id: string) => request<{ deleted: string }>(`/library/documents/${encodeURIComponent(id)}`, undefined, 'DELETE');
export async function importDocument(file: File) {
  const binary = /\.(pdf|docx)$/i.test(file.name);
  if (!/\.(txt|md|markdown|pdf|docx)$/i.test(file.name) || file.size > (binary ? 5 * 1024 * 1024 : 24576) || !file.size)
    throw new Error('Elige TXT/Markdown (hasta 24 KiB) o PDF/DOCX (hasta 5 MiB).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const base64 = btoa(raw);
  return request<LibraryDocument>('/library/imports', { name: file.name, base64 });
}
