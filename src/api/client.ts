export type DocumentSource = { id: string; title: string; revision: string };
export type LibraryDocument = DocumentSource & { content: string };
export type Message = { role: 'user' | 'assistant'; content: string; tools?: string[]; sources?: DocumentSource[]; identity?: { profileId: string; files: { name: string; revision: string }[] } };
export type Conversation = { id: string; messages: Message[]; profileId?: string };
export type Status = { state: string; detail: string; csrf: string };
import type { HermesCatalog, HermesProfile, HermesFile } from '../../shared/hermes-catalog';
import type { McpTools } from '../../shared/hermes-catalog';
import type { HermesActivity } from '../../shared/hermes-activity';
import type { ProfileSkill, ProfileSkillDetail } from '../../shared/hermes-skills';
let csrf = '';
/** An error answered by the backend, with its HTTP status (409 means the data changed meanwhile). */
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Agora-CSRF': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || 'El backend no está disponible.', response.status);
  return data;
}
/** Trades the access token from the link (#acceso=…) for this browser's cookie, then removes it from the address bar. */
async function enterWithLink() {
  const token = /^#acceso=([a-f0-9]{64})$/.exec(window.location.hash)?.[1];
  if (!token) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
}
export async function getStatus() {
  await enterWithLink();
  const status = await request<Status>('/status'); csrf = status.csrf; return status;
}
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
/** Writes a real Obsidian note; `revision` is the version the user opened (sha-256 of its bytes). */
export const saveVaultNote = (vaultId: string, noteId: string, edit: { content: string; revision: string; revealed?: boolean }) =>
  request<{ id: string; revision: string }>(`/hermes/vaults/${encodeURIComponent(vaultId)}/notes/${encodeURIComponent(noteId)}`, edit, 'PUT');
export const createVaultNote = (vaultId: string, folder: string, title: string, content: string) =>
  request<{ id: string; folder: string; title: string }>(`/hermes/vaults/${encodeURIComponent(vaultId)}/notes`, { folder, title, content });
/** A profile's scheduled tasks and kanban cards, managed with Hermes' own functions (user's decision, 18/10/2026). */
export type JobDetail = { id: string; name: string; schedule: string; once: boolean; prompt: string; revision: string; hidden: number };
const profilePath = (id: string) => `/hermes/profiles/${encodeURIComponent(id)}`;
export const getJob = (profileId: string, jobId: string) => request<JobDetail>(`${profilePath(profileId)}/jobs/${encodeURIComponent(jobId)}`);
export const createJob = (profileId: string, job: { name: string; schedule: string; prompt: string }) => request<{ job: string }>(`${profilePath(profileId)}/jobs`, job);
export const changeJob = (profileId: string, jobId: string, change: { action: 'pause' | 'resume' | 'run' | 'remove' } | { action: 'update'; name?: string; schedule?: string; prompt?: string; revision?: string }) =>
  request<{ job: string }>(`${profilePath(profileId)}/jobs/${encodeURIComponent(jobId)}`, change);
export const createCard = (profileId: string, card: { title: string; body?: string }) => request<{ card: string }>(`${profilePath(profileId)}/cards`, card);
export const changeCard = (profileId: string, cardId: string, change: { action: 'complete' | 'unblock' | 'archive' } | { action: 'block'; reason?: string } | { action: 'comment'; body: string }) =>
  request<{ card: string }>(`${profilePath(profileId)}/cards/${encodeURIComponent(cardId)}`, change);
/** The real skills of a profile (its skills/ folder in Hermes); listing and content never reach the model. */
export const listProfileSkills = (profileId: string) => request<{ skills: ProfileSkill[]; truncated: boolean }>(`${profilePath(profileId)}/skills`);
export const readProfileSkill = (profileId: string, skillId: string, reveal = false) =>
  request<ProfileSkillDetail>(`${profilePath(profileId)}/skills/${encodeURIComponent(skillId)}${reveal ? '?reveal=1' : ''}`);
/** Saves a skill's SKILL.md; `revision` is the version the user opened (sha-256 truncated). */
export const saveProfileSkill = (profileId: string, skillId: string, edit: { content: string; revision: string; revealed?: boolean }) =>
  request<{ revision: string; backup: string | null }>(`${profilePath(profileId)}/skills/${encodeURIComponent(skillId)}`, edit, 'PUT');
export const createProfileSkill = (profileId: string, skill: { category: string; name: string; description: string; body: string }) =>
  request<{ id: string; name: string; category: string }>(`${profilePath(profileId)}/skills`, skill);
export const searchVault = (vaultId: string, query: string) => request<{ results: { id: string; title: string; folder: string; snippet: string }[]; truncated: boolean }>(`/hermes/vaults/${encodeURIComponent(vaultId)}/search?q=${encodeURIComponent(query)}`);
/** Calls one MCP tool of a profile by hand with the arguments the user confirmed. */
export const callMcpTool = (profileId: string, serverId: string, tool: string, args: Record<string, unknown>) =>
  request<{ result: string; hidden: number; truncated: boolean }>(`/hermes/profiles/${encodeURIComponent(profileId)}/mcp/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(tool)}/call`, { args });
export const getMcpTools = (profileId: string, serverId: string) => request<McpTools>(`/hermes/profiles/${encodeURIComponent(profileId)}/mcp/${encodeURIComponent(serverId)}/tools`);
export const createConversation = (profileId?: string) => request<Conversation>('/conversations', profileId ? { profileId } : { agent: 'luma', context: 'library-lobby' });
export const getConversation = (id: string) => request<Conversation>(`/conversations/${encodeURIComponent(id)}`);
export type ToolApproval = { requestId: string; tool: string; description: string; args: string; redacted: boolean; truncated: boolean; length: number; rewritable: boolean; expired?: string };
export type ChatProgress = { type: 'status'; stage: 'starting' | 'generating' } | { type: 'delta'; text: string }
  | { type: 'tool'; state: 'start' | 'end'; name: string } | ({ type: 'approval' } & ToolApproval) | { type: 'approval-settled'; requestId: string; reason: string };
export const cancelTurn = (conversationId: string) => request<{ cancelled: string }>(`/conversations/${encodeURIComponent(conversationId)}/cancel`, {});
export const answerApproval = (conversationId: string, requestId: string, choice: 'once' | 'deny') =>
  request<{ answered: string }>(`/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(requestId)}`, { choice });
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
        if (['status', 'delta', 'tool', 'approval', 'approval-settled'].includes(event.type)) onProgress?.(event);
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
