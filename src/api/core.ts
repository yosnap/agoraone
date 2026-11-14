import { csrfToken, request } from './client';

// The Python core, reached through the backend at /api/core/* (cookie, CSRF and origin checked there).
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type Level = 'normal' | 'local_only' | 'private';
export const levelLabels: Record<Level, string> = { normal: 'Normal', local_only: 'Solo en este Mac', private: 'Privada' };

export type NodeType = 'note' | 'person' | 'org' | 'project' | 'amount' | 'date' | 'tag' | 'folder';
/** Notes carry where they live; entity, tag and folder nodes only a type, a title and a degree. */
export type GraphNode = { id: string; type: NodeType; source?: string; sourceName?: string | null; ref?: string; title: string; folder?: string; confidentiality?: Level; degree: number };
export type GraphEdge = { a: string; b: string; kind: 'link' | 'near' | 'mention' | 'in' };
export type GraphLayers = { entities: boolean; tags: boolean; folders: boolean };
export type BrainGraph = { nodes: GraphNode[]; edges: GraphEdge[]; total: number; truncated: boolean; semantic: boolean };
export const getBrainGraph = (discreet: boolean, near: boolean, layers: GraphLayers) =>
  core<BrainGraph>(`/graph?discreet=${+discreet}&near=${+near}&entities=${+layers.entities}&tags=${+layers.tags}&folders=${+layers.folders}`);

export type SearchResult = { source: string; sourceName: string | null; ref: string; title: string; folder: string; confidentiality: Level; snippet: string; matchedBy: string[] };
export const searchBrain = (query: string, limit = 20) =>
  core<{ results: SearchResult[]; semantic: boolean }>(`/search?audience=owner&limit=${limit}&q=${encodeURIComponent(query)}`);

export type IndexStatus = { notes: number; chunks: number; pendingEmbeddings: number; byConfidentiality: Partial<Record<Level, number>>; semanticSearch: boolean; semanticProblem: string | null;
  entities?: { entities: Partial<Record<NodeType, number>>; byModel: number; byRules: number; pending: number; problem: string | null } };
export const getIndexStatus = () => core<IndexStatus>('/index/status');
export type FolderRule = { source: string; folder: string; confidentiality: Exclude<Level, 'normal'> };
export const getFolderRules = () => core<{ rules: FolderRule[] }>('/index/folder-rules');
export const putFolderRules = (rules: FolderRule[]) => core<{ reclassified: number }>('/index/folder-rules', { rules }, 'PUT');

export type Backup = { name: string; kind: string; created: string; bytes: number };
export const getBackups = () => core<{ backups: Backup[]; recoveryKeyPending: boolean }>('/backups');
export const createBackup = () => core<{ name: string; kind: string }>('/backups', {});

export type AddonStatus = 'not_configured' | 'not_found' | 'unreadable' | 'detected' | 'responding' | 'recording';
export type Addon = { id: 'central' | 'costguard' | 'fabrica'; name: string; description: string; offers: string[]; status: AddonStatus; configured: { path?: string | null; dataPath?: string | null; port?: number | null } };
export const getAddons = () => core<{ addons: Addon[] }>('/addons');
export const putAddon = (id: Addon['id'], changes: Addon['configured']) => core<{ addons: Addon[] }>(`/addons/${id}`, changes, 'PUT');
export type AgentUsage = { agent: string; input: number; output: number; cacheRead: number; cacheWrite: number; turns: number };
export const getCostguardUsage = (hours: number) => core<{ hours: number; agents: AgentUsage[]; turns: number }>(`/addons/costguard/usage?hours=${hours}`);
export type BrainMcpSetup = { name: string; command: string | null; args: string[]; env: Record<string, string> };
export const getBrainMcpSetup = () => core<BrainMcpSetup>('/brain-mcp');

export type Persona = { id: string; name: string; origin: string; conveys: string; language: string; voice: string };
export type ToneKey = 'register' | 'humor' | 'length' | 'address' | 'language';
export type AssistantSettings = { persona: string; model: string; engine: string | null; tone: Record<ToneKey, string>; compatible: { baseUrl: string | null; model: string | null } };
export const getPersonas = () => core<{ personas: Persona[]; tone: Record<ToneKey, string[]> }>('/assistant/personas');
export const getAssistantSettings = () => core<AssistantSettings>('/assistant/settings');
export const putAssistantSettings = (changes: Partial<AssistantSettings>) => core<AssistantSettings>('/assistant/settings', changes, 'PUT');
export const getEngines = () => core<{ engines: { name: string; available: boolean }[]; active: string | null; model: string }>('/assistant/engines');
/** Saves (or with null forgets) a key in the Keychain; keys are never read back. */
export const putKey = (kind: 'anthropic' | 'compatible', key: string | null) => core<{ saved: boolean }>(`/assistant/keys/${kind}`, { key }, 'PUT');

export type Source = { n: number; title: string; folder: string; source: string; ref: string };
export type AssistantMessage = { role: 'user' | 'assistant'; content: string; sources: Source[]; engine: string | null; model: string | null; failed: boolean; created_at: string };
export type ConversationSummary = { id: number; title: string; persona: string; updated_at: string };
export const listAssistantConversations = () => core<{ conversations: ConversationSummary[] }>('/assistant/conversations');
export const createAssistantConversation = () => core<{ id: number; persona: string }>('/assistant/conversations', {});
export const getAssistantConversation = (id: number) =>
  core<ConversationSummary & { messages: AssistantMessage[] }>(`/assistant/conversations/${id}`);

export type Stage = 'recuerda' | 'piensa' | 'responde';
export type AssistantEvent =
  | { kind: 'stage'; stage: Stage; engine?: string; model?: string }
  | { kind: 'sources'; sources: Source[] }
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; tool: 'search'; query: string; found: string[] }
  | { kind: 'tool'; tool: 'read'; id: string; title: string; n: number }
  | { kind: 'done'; engine: string; model: string };

/** Sends a question and follows the answer's Server-Sent Events until it ends; an `error` event throws. */
export async function askAssistant(id: number, message: string, onEvent: (event: AssistantEvent) => void, signal?: AbortSignal) {
  const response = await fetch(`/api/core/assistant/conversations/${id}/messages`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Agora-CSRF': csrfToken() },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'No se pudo enviar la pregunta.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No se pudo leer la respuesta.');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!kind || data === undefined) continue;
        const payload = JSON.parse(data);
        if (kind === 'error') throw new Error(payload.error);
        onEvent({ kind, ...payload } as AssistantEvent);
        if (kind === 'done') return;
      }
      if (done) throw new Error('La conexión se interrumpió. Recarga la conversación para ver si se completó.');
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export type WordCount = { word: string; count: number };
export type TokenProject = { project: string; tokens: number; cacheTokens: number; turns: number };
export type CoreSummary = {
  core: { version: string; startedAt: string; uptimeSeconds: number };
  brain: IndexStatus;
  watson: {
    conversations: number; questions: number; questions24h: number; failed: number;
    impact: { question: string; at: string; sources: number }[];
    cited: { title: string; folder: string; source: string; ref: string; count: number }[];
    searches: { query: string; count: number }[];
    words: WordCount[];
  };
  noteWords: WordCount[];
  costguard: { available: false } | ({ available: true } & Record<'24h' | '7d' | '30d', { projects: TokenProject[]; agents: AgentUsage[] }>);
};
export const getCoreSummary = (discreet: boolean) => core<CoreSummary>(`/summary?discreet=${+discreet}`);

export type Scope = { id: number; slug: string; name: string; color: string | null; fiscal: boolean };
export const getScopes = () => core<{ scopes: Scope[] }>('/scopes');
export const createScope = (name: string, fiscal = false) => core<{ scopes: Scope[] }>('/scopes', { name, fiscal });
export type MailProvider = 'gmail' | 'icloud' | 'namecheap' | 'hostinger' | 'other';
export type MailPreset = { name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; hint: string };
export type MailAccount = {
  id: number; address: string; label: string | null; provider: MailProvider; username: string; imapHost: string; imapPort: number;
  smtpHost: string | null; smtpPort: number | null; scopeId: number | null; scopeName: string | null; confidentiality: Level;
  maxAgeDays: number; enabled: boolean; status: 'pending' | 'ok' | 'auth' | 'unreachable' | 'error'; lastError: string | null;
  lastSyncAt: string | null; messages: number; hasPassword: boolean;
};
export type MailAccountIn = {
  address: string; provider: MailProvider; username?: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number;
  scopeId?: number | null; confidentiality: Level; maxAgeDays: number; password?: string;
};
export const getMailPresets = () => core<{ presets: Record<MailProvider, MailPreset> }>('/mail/presets');
export const getMailAccounts = () => core<{ accounts: MailAccount[] }>('/mail/accounts');
export const createMailAccount = (account: MailAccountIn) => core<{ accounts: MailAccount[] }>('/mail/accounts', account);
export const changeMailAccount = (id: number, changes: Partial<MailAccountIn & { enabled: boolean; password: string | null }>) =>
  core<{ accounts: MailAccount[] }>(`/mail/accounts/${id}`, changes, 'PUT');
export const deleteMailAccount = (id: number) => core<{ accounts: MailAccount[] }>(`/mail/accounts/${id}`, undefined, 'DELETE');
export const syncMailAccount = (id: number) => core<{ result: { status: string; added: number }; accounts: MailAccount[] }>(`/mail/accounts/${id}/sync`, {});
