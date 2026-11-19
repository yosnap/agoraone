import { ApiError, csrfToken, request } from './client';

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
export type BrainArea = { name: string; notes: number; subfolders: number; changed: string | null; description: string | null; written: boolean };
export type LatelyEntry = { kind: 'nota' | 'reunión'; text: string; detail: string | null; when: string; id: number; key?: string };
export const getBrainHome = (discreet: boolean) => core<{ areas: BrainArea[]; lately: { today: LatelyEntry[]; yesterday: LatelyEntry[] } }>(`/brain/home?discreet=${+discreet}`);
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

/** The connectors (/connectors): every external module described the same way. A key is never answered, only `hasKey`. */
export type ConnectorStatus = 'not_configured' | 'legacy' | 'saved' | 'responding' | 'failing' | 'detected' | 'recording' | 'not_found' | 'unreadable' | 'guide';
export type ConnectorKind = 'web_api' | 'local_port' | 'local_file' | 'guide';
export type ConnectorSettings = { url?: string | null; hasKey?: boolean; port?: number | null; path?: string | null; dataPath?: string | null };
export type ConnectorState = { status: ConnectorStatus; configured: ConnectorSettings; notice: string | null; storeProblem: string | null };
export type Connector = { id: string; name: string; description: string; kind: ConnectorKind; modules: Record<string, boolean>; views: string[];
  window: string | null; scopes: string[]; hint: string | null; state: ConnectorState };
/** What a connector saves: a null forgets that setting; without `key`, a web API keeps the saved one. */
export type ConnectorChanges = { url?: string | null; key?: string | null; port?: number | null; path?: string | null; dataPath?: string | null };
const connectorPath = (id: string) => `/connectors/${encodeURIComponent(id)}`;
export const getConnectors = () => core<{ connectors: Connector[] }>('/connectors');
/** Only one connector's state (nothing of the others is checked). */
export const getConnector = (id: string) => core<Connector>(connectorPath(id));
export const putConnector = (id: string, changes: ConnectorChanges) => core<Connector>(connectorPath(id), changes, 'PUT');
/** Tries what is typed (not saved) or, when missing, what is saved; the answer depends on the connector's kind. */
export const testConnector = <T>(id: string, typed: ConnectorChanges) => core<T>(`${connectorPath(id)}/test`, typed, 'POST');
/** Forgets the key or the local setting; never what was read. */
export const deleteConnector = (id: string) => core<Connector>(connectorPath(id), undefined, 'DELETE');
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
/** The «Agentes» section: whether Watson is answering now and what it did in 24 h (actions and outcomes only). */
export type WatsonEvent = { id: number; at: string; actor: 'watson' | 'user'; action: string; outcome: 'done' | 'denied' | 'failed' | 'undone' };
export type WatsonActivity = { answering: number; since: string | null; lastAt: string | null; count: number; events: WatsonEvent[] };
/** Claude Code and Codex sessions of this Mac moved in 24 h: metadata only, never the conversation. */
export type CodingHost = 'orca' | 'vscode' | 'codex-app' | 'claude-desktop' | 'terminal' | 'sdk';
export type CodingSession = { id: string; tool: 'claude' | 'codex'; host: CodingHost | null; inOrca: boolean; project: string | null; branch: string | null; model: string | null;
  state: 'working' | 'tool' | 'waiting' | 'paused'; startedAt: string | null; lastAt: string; tokens: { input: number; output: number }; turns: number };
export const getCodingSessions = () => core<{ sessions: CodingSession[] }>('/agents/coding');
/** «Abrir en Orca»: that session's workspace and terminal on screen in Orca (only the session's id is sent). */
export const openCodingInOrca = (id: string) => core<{ ok: true }>(`/agents/coding/${id}/orca`, {});
export const getWatsonActivity = () => core<WatsonActivity>('/agents/watson');
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
/** A mail rule Watson proposed: created only with the user's «Crear regla» (or a plain «sí»), exactly as shown. */
export type ProposedRule = { name: string; action: MailRuleAction; sender?: string; subject?: string; words?: string; confidentiality?: Level };
export const acceptProposal = (id: string) => core<{ id: number; name: string }>(`/assistant/proposals/${encodeURIComponent(id)}/accept`, {});
export const dismissProposal = (id: string) => core<{ ok: true }>(`/assistant/proposals/${encodeURIComponent(id)}/dismiss`, {});
export type AssistantEvent =
  | { kind: 'stage'; stage: Stage; engine?: string; model?: string }
  | { kind: 'sources'; sources: Source[] }
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; tool: 'search'; query: string; found: string[] }
  | { kind: 'tool'; tool: 'read'; id: string; title: string; n: number }
  | { kind: 'tool'; tool: 'inbox'; filter: string; count: number }
  | { kind: 'tool'; tool: 'clients'; filter: string; count: number }
  | { kind: 'tool'; tool: 'rule_proposal'; id: string; rule: ProposedRule }
  | { kind: 'tool'; tool: 'cleanup_proposal'; id: string; action: 'archive' | 'trash'; messages: CleanupMessage[] }
  | { kind: 'tool'; tool: 'reorg_proposal'; id: string; summary: string; moves: ReorgMove[] }
  | { kind: 'tool'; tool: 'vault_outline'; notes: number; folders: number }
  | { kind: 'tool'; tool: 'quote_proposal'; id: string; quote: ProposedQuote }
  | { kind: 'tool'; tool: 'event_proposal'; id: string; event: { title: string; start: string; end: string; allDay: boolean; location: string | null; notes: string | null; calendar: string | null } }
  | { kind: 'tool'; tool: 'note_proposal'; id: string; note: { title: string; folder: string; content: string } }
  | { kind: 'tool'; tool: 'meetings'; query: string; count: number }
  | { kind: 'tool'; tool: 'issue_proposal'; id: string; issue: ProposedIssue }
  | { kind: 'tool'; tool: 'orca_proposal'; proposal: OrcaProposal }
  | { kind: 'tool'; tool: 'meeting'; title: string; part: number }
  | { kind: 'tool'; tool: 'agenda' | 'day' | 'projects'; [key: string]: unknown }
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
export type MailProvider = 'gmail' | 'icloud' | 'microsoft' | 'other' | 'resend' | 'smtp';
/** Presets of accounts that only send (no mailbox to read). */
export const sendOnly = (provider: MailProvider) => provider === 'resend' || provider === 'smtp';
export type MailPreset = { name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; hint: string };
export type MailAccount = {
  id: number; address: string; label: string | null; kind: 'mailbox' | 'send'; inbound: boolean; provider: MailProvider; auth: 'password' | 'microsoft'; username: string; imapHost: string; imapPort: number;
  smtpHost: string | null; smtpPort: number | null; scopeId: number | null; scopeName: string | null; confidentiality: Level;
  maxAgeDays: number; enabled: boolean; status: 'pending' | 'ok' | 'auth' | 'unreachable' | 'error'; lastError: string | null;
  lastSyncAt: string | null; messages: number; hasPassword: boolean;
};
export type MailAccountIn = {
  address: string; provider: MailProvider; username?: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number;
  scopeId?: number | null; confidentiality: Level; maxAgeDays: number; password?: string; inbound?: boolean;
};
export const getMailPresets = () => core<{ presets: Record<MailProvider, MailPreset> }>('/mail/presets');
export const getMailAccounts = () => core<{ accounts: MailAccount[] }>('/mail/accounts');
export const createMailAccount = (account: MailAccountIn) => core<{ accounts: MailAccount[] }>('/mail/accounts', account);
export const changeMailAccount = (id: number, changes: Partial<Omit<MailAccountIn, 'smtpHost'> & { smtpHost: string | null; enabled: boolean; password: string | null }>) =>
  core<{ accounts: MailAccount[] }>(`/mail/accounts/${id}`, changes, 'PUT');
export const deleteMailAccount = (id: number) => core<{ accounts: MailAccount[] }>(`/mail/accounts/${id}`, undefined, 'DELETE');
/** Signs in to an account's SMTP server without sending anything. */
export const checkMailSender = (id: number) => core<{ result: { status: string; detail: string }; accounts: MailAccount[] }>(`/mail/accounts/${id}/check`, {});
export const syncMailAccount = (id: number) => core<{ result: { status: string; added: number }; accounts: MailAccount[] }>(`/mail/accounts/${id}/sync`, {});
// WhatsApp through Zernio, read-only. The key goes to the Keychain and is never returned: only whether there is one.
export type ChatAccount = {
  id: number; provider: 'zernio'; phone: string | null; label: string | null; scopeId: number | null; scopeName: string | null; confidentiality: Level;
  maxAgeDays: number; enabled: boolean; status: MailAccount['status']; lastError: string | null; lastSyncAt: string | null; conversations: number; messages: number;
};
export type ChatSyncResult = { status: 'ok' | 'busy' | 'auth' | 'unreachable' | 'error'; added: number; read: number; pending: number; skipped: number; accounts: number; error: string | null };
export type ChatSettings = { hasKey: boolean; accounts: ChatAccount[]; lastSync: (ChatSyncResult & { at: string }) | null };
export const getChatSettings = () => core<ChatSettings>('/chat/settings');
export const putChatKey = (key: string | null) => core<ChatSettings>('/chat/key', { key }, 'PUT');
export const testChat = () => core<{ whatsapp: number; others: number }>('/chat/test', {});
export const syncChat = () => core<ChatSettings & { result: ChatSyncResult }>('/chat/sync', {});
export const changeChatAccount = (id: number, changes: Partial<{ scopeId: number | null; confidentiality: Level; maxAgeDays: number; enabled: boolean }>) =>
  core<ChatSettings>(`/chat/accounts/${id}`, changes, 'PATCH');
/** The user's rules for WhatsApp conversations: like the mail ones, the first that matches decides and only makes the level stricter. */
export type ChatRule = {
  id: number; name: string; contact: string | null; accountId: number | null; words: string | null; action: MailRuleAction;
  label: string | null; scopeId: number | null; confidentiality: Level | null; enabled: boolean;
};
export type ChatRuleIn = Omit<ChatRule, 'id'>;
export const getChatRules = () => core<{ rules: ChatRule[] }>('/chat/rules');
export const createChatRule = (rule: ChatRuleIn) => core<{ rules: ChatRule[] }>('/chat/rules', rule);
export const changeChatRule = (id: number, changes: Partial<ChatRuleIn>) => core<{ rules: ChatRule[] }>(`/chat/rules/${id}`, changes, 'PATCH');
export const deleteChatRule = (id: number) => core<{ rules: ChatRule[] }>(`/chat/rules/${id}`, undefined, 'DELETE');
export type JevPoint = 'mail' | 'chat' | 'deadlines' | 'tasks' | 'meetings' | 'fiscal' | 'watson';
export type JevSettings = {
  hasKey: boolean; model: string; monthlyUsd: number; threshold: number; aliases: string[];
  points: Record<JevPoint, boolean>; pointLabels: Record<JevPoint, string>;
  usage: { month: string; calls: number; inputTokens: number; outputTokens: number; spentUsd: number; capTokens: number };
  /** Jev in shadow: decisions kept, how many compare with what is shown now and in how many it agrees. */
  shadow: Record<'mail' | 'chat', JevShadowCounts>;
};
/** `advertisingAsOther`: advertising kept as «other», left out of the comparison; `withdrawn`: decisions about what is
 * no longer normal (or gone), not shown. */
export type JevShadowCounts = { decisions: number; compared: number; agree: number; advertisingAsOther: number; withdrawn: number };
export type JevSettingsIn = Partial<{ model: string; monthlyUsd: number; threshold: number; points: Partial<Record<JevPoint, boolean>> }>;
export const getJevSettings = () => core<JevSettings>('/jev/settings');
export const putJevSettings = (changes: JevSettingsIn) => core<JevSettings>('/jev/settings', changes, 'PUT');
export const putJevKey = (key: string | null) => core<JevSettings>('/jev/key', { key }, 'PUT');
export const testJev = () => core<{ models: string[] }>('/jev/test', {});

/** A classified conversation, without the text of its messages; a private one carries no participant. */
export type ChatSummary = {
  id: number; kind: InboxKind; source: 'rule' | 'model' | 'local'; ruleId: number | null; ruleName: string | null; label: string | null;
  confidentiality: Level; state: InboxState; summary: string | null; details: { asks?: string[]; dates?: string[]; amounts?: string[]; language?: string | null };
  participant: { name: string | null; phone: string | null } | null; account: { id: number; phone: string | null; label: string | null };
  /** The user's client this number belongs to (never for a private conversation). */
  client: { name: string } | null;
  scope: { id: number; name: string; color: string | null } | null; lastIncomingAt: string | null; updatedAt: string;
};
export const getChatSummaries = (state: InboxState = 'pending') =>
  core<{ items: ChatSummary[]; counts: Record<InboxState | 'quiet', number>; problem: string | null }>(`/chat/summaries?state=${state}`);
export type MicrosoftSignIn = { state: 'none' | 'waiting' | 'done' | 'declined' | 'expired' | 'error' | 'cancelled'; message?: string | null; userCode?: string; verificationUri?: string; expiresAt?: number };
export const getMicrosoftClient = () => core<{ clientId: string | null }>('/mail/microsoft');
export const putMicrosoftClient = (clientId: string | null) => core<{ clientId: string | null }>('/mail/microsoft', { clientId }, 'PUT');
export const startMicrosoftSignIn = (id: number) => core<MicrosoftSignIn>(`/mail/accounts/${id}/microsoft`, {});
export const getMicrosoftSignIn = (id: number) => core<MicrosoftSignIn>(`/mail/accounts/${id}/microsoft`);
export type MailRuleAction = 'invoice' | 'client' | 'personal' | 'important' | 'ignore';
export type MailRule = {
  id: number; name: string; sender: string | null; accountId: number | null; subject: string | null; words: string | null;
  action: MailRuleAction; scopeId: number | null; confidentiality: Level | null; enabled: boolean;
};
export type MailRuleIn = Omit<MailRule, 'id'>;
export const getMailRules = () => core<{ rules: MailRule[] }>('/mail/rules');
export const createMailRule = (rule: MailRuleIn) => core<{ rules: MailRule[] }>('/mail/rules', rule);
export const changeMailRule = (id: number, changes: Partial<MailRuleIn>) => core<{ rules: MailRule[] }>(`/mail/rules/${id}`, changes, 'PUT');
export const deleteMailRule = (id: number) => core<{ rules: MailRule[] }>(`/mail/rules/${id}`, undefined, 'DELETE');
export type InboxKind = 'invoice' | 'payment' | 'job' | 'client' | 'incident' | 'appointment' | 'personal' | 'important' | 'advertising' | 'other';
export type InboxState = 'pending' | 'done' | 'dismissed';
export type InboxItem = {
  id: number; kind: InboxKind; source: 'rule' | 'model' | 'local'; ruleId: number | null; ruleName: string | null; confidentiality: Level;
  summary: string | null; details: { asks?: string[]; dates?: string[]; amounts?: string[]; language?: string | null };
  state: InboxState; proposal: 'archive_invoice' | 'add_to_project' | 'create_event' | null;
  suggestion: { sender: string; action: MailRuleAction; name: string } | null;
  from: { name: string | null; address: string | null }; subject: string | null; sentAt: string;
  account: { id: number; address: string }; scope: { id: number; name: string; color: string | null } | null;
  attachments: number; announcedAt: string | null; moved: 'trash' | 'archive' | null; client: { name: string; projects: string[] } | null;
};
export type InboxCounts = { pending: number; done: number; dismissed: number; unread: number; since: string | null };
export const getInbox = (state: InboxState = 'pending') => core<{ items: InboxItem[]; counts: InboxCounts; problem: string | null }>(`/mail/inbox?state=${state}`);
export const archiveAllInbox = () => core<{ archived: number; counts: InboxCounts }>('/mail/inbox/archive-all', {});
export const decideInbox = (id: number, state: InboxState) => core<{ ok: true }>(`/mail/inbox/${id}`, { state }, 'PUT');
/** Moves these cards' messages to their account's trash (or archive), only after the user confirmed it. Never deleted for good. */
export const moveInboxMail = (ids: number[], action: 'trash' | 'archive') =>
  core<{ moved: number; problems: string[]; counts: InboxCounts }>('/mail/inbox/move', { ids, action });
/** The advertising still in the accounts' inboxes (it never gets a card), to review before «Eliminar publicidad». */
export const getInboxAdvertising = () => core<{ messages: CleanupMessage[] }>('/mail/inbox/advertising');
/** The cards the assistant announces now; the core hands each one out only once. */
export const claimAnnouncements = () => core<{ items: InboxItem[] }>('/mail/inbox/announce', {});
export type InvoiceFields = { supplier: string; taxId?: string | null; issuedOn: string; total: string; currency: string; base?: string | null; vat?: string | null; notes?: string | null };
export type InvoiceSource = { kind: 'attachment'; part: number; name?: string } | { kind: 'link'; url: string };
export type InvoicePrepared = {
  folders: FiscalFolder[]; folderId: number | null;
  source: { kind: 'attachment'; part: number; name: string } | null; sources: { kind: 'attachment'; part: number; name: string }[];
  links: { url: string; host: string }[];
  proposal: InvoiceFields; doubts: string[]; destination: string;
};
export type Invoice = InvoiceFields & { id: number; direction: 'received' | 'issued'; messageId: number | null; doubts: string[]; quarter: string; path: string;
  client?: string | null };
export type FolderKind = 'autonomo' | 'empresa' | 'personal';
export type FiscalFolder = { id: number; name: string; kind: FolderKind; path: string; scopeId: number | null; holder: string | null };
export const getFiscalFolders = () => core<{ folders: FiscalFolder[] }>('/fiscal/folders');
export const chooseFiscalFolder = () => core<{ path: string | null }>('/fiscal/folders/choose', {});
export const addFiscalFolder = (folder: Omit<FiscalFolder, 'id' | 'holder'>) => core<{ folders: FiscalFolder[] }>('/fiscal/folders', folder);
export const changeFiscalFolder = (id: number, changes: Partial<Omit<FiscalFolder, 'id' | 'path'>>) => core<{ folders: FiscalFolder[] }>(`/fiscal/folders/${id}`, changes, 'PUT');
export const removeFiscalFolder = (id: number) => core<{ folders: FiscalFolder[] }>(`/fiscal/folders/${id}`, undefined, 'DELETE');
export const prepareInvoice = (messageId: number) => core<InvoicePrepared>('/fiscal/invoices/prepare', { messageId });
export type Category = 'gastos' | 'compras';
export const fileInvoice = (messageId: number, folderId: number, category: Category | null, source: InvoiceSource, fields: InvoiceFields, doubts: string[]) =>
  core<{ id: number; path: string; quarter: string }>('/fiscal/invoices', { messageId, folderId, category, source, fields, doubts });
export const getInvoices = (quarter?: string) => core<{ invoices: Invoice[] }>(`/fiscal/invoices${quarter ? `?quarter=${quarter}` : ''}`);
export type FolderPlan = { moves: { from: string; to: string }[]; undecided: string[]; more: number };
export const getFolderPlan = (id: number) => core<FolderPlan>(`/fiscal/folders/${id}/plan`);
export const applyFolderPlan = (id: number, moves: { from: string; to: string }[]) =>
  core<{ moved: { from: string; to: string }[]; backup: string; error: string | null }>(`/fiscal/folders/${id}/apply`, { moves });
export type UploadState = { open: boolean; url?: string; qr?: string; expiresAt?: number; received?: number | null; receiving?: boolean };
/** A receipt to look at (photos as JPEG, PDFs as they are) and its data read by Claude Haiku to fill the form. */
/** The receipt as an image in memory (a blob: URL): the core asks for the CSRF header even on reads, which an
 * <img> cannot send, so it is fetched here. The caller revokes the URL when done. */
export async function receiptPreview(id: number): Promise<string> {
  const response = await fetch(`/api/core/fiscal/receipts/${id}/preview`, { headers: csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {} });
  if (!response.ok) throw new ApiError('No se puede enseñar este recibo.', response.status, {});
  return URL.createObjectURL(await response.blob());
}
export const readReceipt = (id: number) => core<InvoiceFields>(`/fiscal/receipts/${id}/read`, {});
export type Receipt = { id: number; name: string | null; mediaType: string; bytes: number; fields: Partial<InvoiceFields>; uploadedAt: string;
  source: 'qr' | 'inbox'; inboxFolder: number | null };
export const openUpload = () => core<UploadState>('/fiscal/receipts/upload', {});
export const getUpload = () => core<UploadState>('/fiscal/receipts/upload');
export const closeUpload = () => core<UploadState>('/fiscal/receipts/upload', undefined, 'DELETE');
export const getReceipts = () => core<{ receipts: Receipt[]; inbox?: string }>('/fiscal/receipts');
export const dismissReceipt = (id: number) => core<{ receipts: Receipt[] }>(`/fiscal/receipts/${id}`, { state: 'dismissed' }, 'PUT');
export const fileReceipt = (id: number, folderId: number, category: Category | null, fields: InvoiceFields) =>
  core<{ id: number; path: string }>(`/fiscal/receipts/${id}/file`, { folderId, category, fields });
export const getQonto = () => core<{ login: string | null; hasKey: boolean }>('/fiscal/qonto');
export const putQonto = (changes: { login?: string | null; secret?: string | null }) => core<{ login: string | null; hasKey: boolean }>('/fiscal/qonto', changes, 'PUT');
export const checkQonto = () => core<{ name: string | null; accounts: number }>('/fiscal/qonto/check', {});
export type IncomeRow = { date: string; number: string; client: string; taxId: string; concept: string; base: number | null; vatRate: number | null;
  withholdingRate: number | null; withholding: number | null; total: number | null; currency: string; file?: string; manual?: ManualSaved | null;
  /** One of the user's clients (Central's or their own) with this exact tax id, when there is one: only shown. */
  knownClient?: string };
export type FiscalIssue = { key: string; text: string; items: { label: string; detail: string; path?: string | null; qonto?: string }[] };
export type QuarterView = { folder: FiscalFolder; income: IncomeRow[]; incomeProblem: string | null; expenses: (Invoice & { file?: string; manual?: ManualSaved | null })[]; notes: string[]; issues: FiscalIssue[]; reading: number; readingTotal: number };
export const downloadFromQonto = (folderId: number, year: number, quarter: number, numbers: string[]) =>
  core<{ saved: { number: string; path: string }[]; failed: { number: string; error: string }[] }>(`/fiscal/folders/${folderId}/qonto-download`, { year, quarter, numbers });
export const getQuarter = (folderId: number, year: number, quarter: number) => core<QuarterView>(`/fiscal/folders/${folderId}/quarter?year=${year}&quarter=${quarter}`);
export const makeQuarterExcel = (folderId: number, year: number, quarter: number) => core<{ path: string }>(`/fiscal/folders/${folderId}/excel`, { year, quarter });
export const openFiscalFile = (folderId: number, path: string | null, reveal = false) => core<{ ok: true }>(`/fiscal/folders/${folderId}/open`, { path, reveal });
export type CentralClient = { name: string; company: string | null; domains: string[];
  projects: { name: string; status: string; phase: string | null; repo?: string | null }[]; websites: { url: string; status: string | null }[] };
export type CentralServer = { name: string; status: string | null; provider: string | null; projects: string[] };
export type CentralState = { configured: boolean; transport?: 'http' | null; notice?: string | null; snapshot: { clients: CentralClient[]; servers: CentralServer[]; fetchedAt: string } | null; problem: string | null };
export const getCentral = () => core<CentralState>('/central');
export const refreshCentral = () => core<CentralState>('/central/refresh', {});
/** Data typed by hand, only for an invoice of the folder that could not be read in any way (rates in percent). */
export type ManualFields = { name?: string; taxId?: string; number?: string; issuedOn: string; base?: string; vatRate?: string; vat?: string;
  withholdingRate?: string; withholding?: string; total: string; currency?: string };
/** What was saved: rates as fractions (0.21). */
export type ManualSaved = { name: string | null; taxId: string | null; number: string | null; issuedOn: string; base: string | null; vatRate: number | null;
  vat: string | null; withholdingRate: number | null; withholding: string | null; total: string; currency: string };
export const saveManual = (folderId: number, path: string, fields: ManualFields) => core<{ ok: true }>(`/fiscal/folders/${folderId}/manual`, { path, fields }, 'PUT');
export const removeManual = (folderId: number, path: string) => core<{ ok: true }>(`/fiscal/folders/${folderId}/manual?path=${encodeURIComponent(path)}`, undefined, 'DELETE');
export const getFiscalReading = () => core<{ withClaude: boolean }>('/fiscal/reading');
export const putFiscalReading = (withClaude: boolean) => core<{ withClaude: boolean }>('/fiscal/reading', { withClaude }, 'PUT');

/** The macOS calendars (EventKit): permission, each calendar's scope and confidentiality, the agenda and
 * events or reminders created only after the user confirms them. */
export type CalendarAccess = 'granted' | 'denied' | 'undetermined' | 'restricted' | 'write_only' | 'unavailable';
export type CalendarStatus = { events: CalendarAccess; reminders: CalendarAccess };
export type CalendarInfo = { id: string; title: string; kind: 'event' | 'reminder'; account: string; writable: boolean;
  scopeId: number | null; confidentiality: Level; hidden: boolean };
/** Where an item comes from, for the screen: its calendar, the account that holds it and the scope it was given. */
export type CalendarOrigin = { calendar?: string | null; account?: string | null; scope?: { name: string; color: string | null } | null };
export type CalendarEvent = { id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string | null } & CalendarOrigin;
export type CalendarReminder = { id: string; calendarId: string; title: string; due: string | null } & CalendarOrigin;
export type Agenda = { events: CalendarEvent[]; reminders: CalendarReminder[]; overlaps: [string, string][]; problem: string | null };
export type NewEvent = { calendarId?: string | null; title: string; start: string; end: string; allDay?: boolean; location?: string | null;
  notes?: string | null; overlapOk?: boolean; inboxId?: number | null };
export const getCalendarStatus = () => core<CalendarStatus>('/calendar/status');
export const askCalendarAccess = () => core<CalendarStatus>('/calendar/access', {});
export const getCalendars = () => core<{ calendars: CalendarInfo[]; problem: string | null }>('/calendar/calendars');
export const changeCalendar = (id: string, change: { scopeId: number | null; confidentiality: Level; hidden: boolean }) =>
  core<{ ok: true }>(`/calendar/calendars/${encodeURIComponent(id)}`, change, 'PUT');
export const getAgenda = (when: 'hoy' | 'mañana' | 'semana') => core<Agenda>(`/calendar/agenda?when=${encodeURIComponent(when)}`);
/** Any period, local days from `from` to `to` (both included, YYYY-MM-DD), for the calendar views. */
export type EventPerson = { name: string | null; email: string | null; status: 'accepted' | 'declined' | 'tentative' | 'pending'; me: boolean };
export type EventDetail = { id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string | null; notes: string | null;
  url: string | null; attendees: EventPerson[]; organizer: EventPerson | null; recurring: boolean; links: { url: string; meeting: string | null }[];
  editable: boolean; why: string | null; revision: string };
export const getCalendarEvent = (id: string) => core<EventDetail>(`/calendar/event?id=${encodeURIComponent(id)}`);
export const changeCalendarEvent = (change: { id: string; revision: string; title: string; start: string; end: string; allDay: boolean;
  location: string | null; notes: string | null; overlapOk: boolean }) => core<{ id: string; clashes: number }>('/calendar/event', change, 'PUT');
export const getAgendaRange = (from: string, to: string) => core<Agenda>(`/calendar/agenda?from=${from}&to=${to}`);
export const createEvent = (event: NewEvent) => core<{ id: string; clashes: number }>('/calendar/events', event);
export const createReminder = (reminder: { calendarId?: string | null; title: string; due?: string | null; notes?: string | null; inboxId?: number | null }) =>
  core<{ id: string }>('/calendar/reminders', reminder);

/** Reminders: missed calls, meetings about to start, mail deadlines and the morning summary. */
export type AlertItem = { key: string; kind: 'call' | 'meeting' | 'commitment' | 'summary'; title: string; body: string; at: string };
export type AlertSettings = { morning: string; quietFrom: string; quietTo: string; missedCalls: boolean; meetings: boolean; commitments: boolean;
  summary: boolean; callsLevel: Level };
export type AlertsView = { alerts: AlertItem[]; morning: AlertItem | null; problems: string[]; callsProblem: 'permission' | 'missing' | 'unreadable' | null; settings: AlertSettings; contacts: string };
export const getAlerts = () => core<AlertsView>('/alerts');
export const putAlertSettings = (changes: Partial<AlertSettings>) => core<AlertSettings>('/alerts/settings', changes, 'PUT');
export const askContactsAccess = () => core<{ contacts: string }>('/alerts/contacts', {});
export const openFullDiskAccess = () => core<{ ok: true }>('/alerts/full-disk-access', {});
export type DueAlert = { key: string; title: string; body: string; kind: AlertItem['kind'] };
export const getDueAlerts = () => core<{ notifications: DueAlert[] }>('/alerts/due');
export const ackAlerts = (keys: string[]) => core<{ ok: true }>('/alerts/ack', { keys });

/** Trabajos: the central bot (a Hermes profile name; «default» is the root profile), default recipient of a commission. */
export type JobsSettings = { central: string };
export const getJobsSettings = () => core<JobsSettings>('/jobs/settings');
export const putJobsSettings = (changes: JobsSettings) => core<JobsSettings>('/jobs/settings', changes, 'PUT');

/** Clients' projects (Central) with CostGuard's tokens per period, matched only by the same folder name. */
export type ProjectUsage = Record<'24h' | '7d' | '30d', { tokens: number; turns: number }>;
export type ClientProjects = {
  clients: { name: string; projects: { name: string; status: string | null; phase: string | null; ambiguous: boolean; usage: ProjectUsage | null }[] }[];
  unmatched: { name: string; usage: ProjectUsage }[]; costguard: boolean; problem: string | null; fetchedAt: string | null;
};
export const getClientProjects = () => core<ClientProjects>('/jobs/projects');

/** Local speech to text (whisper.cpp): what is installed and chosen, and transcribing a short clip. */
export type VoiceSettings = { binary: string | null; ffmpeg: string | null; model: string | null; language: string };
export type VoiceStatus = VoiceSettings & { chosen: VoiceSettings; binaries: string[]; ffmpegs: string[];
  models: { name: string; path: string; bytes: number }[]; ready: boolean; platform: string; missing: ('binary' | 'ffmpeg' | 'model')[] };
export const getVoiceStatus = () => core<VoiceStatus>('/voice/status');
/** Watson's voice (1.7): the engine and voice chosen, what speaks now (macOS when VoiceStudio is closed) and the
 * voices VoiceStudio offers (null when it is not open). */
export type TtsEngine = 'auto' | 'macos' | 'voicestudio';
export type TtsQuality = 'fast' | 'balanced' | 'best';
export type TtsSettings = { engine: TtsEngine; voice: string | null; speed: number; macVoice: string | null; quality: TtsQuality; openAtStart: boolean };
export type TtsNow = { engine: 'macos' | 'voicestudio'; voice: string | null; speed: number; macVoice: string | null; problem: string | null; steps: number };
/** `opening`: AgoraOne is opening VoiceStudio right now; `installed`: VoiceStudio is on this Mac; `running`: its
 * app is running (it may still be loading). */
export type TtsView = { settings: TtsSettings; now: TtsNow; voicestudio: { id: string; name: string; language: string | null }[] | null; opening: boolean; installed: boolean; running: boolean };
export const getTts = () => core<TtsView>('/voice/tts');
export const putTts = (changes: Partial<TtsSettings>) => core<TtsView>('/voice/tts', changes, 'PUT');
/** A question was sent: VoiceStudio loads its voice while Watson thinks (nothing when it is ready). */
export const warmVoice = () => core<{ ok: boolean }>('/voice/warm', {}, 'POST');
/** One piece of an answer spoken by VoiceStudio on this Mac, as audio in memory (a blob: URL the caller revokes). */
export async function speakPiece(text: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/core/voice/speak', { method: 'POST', signal, body: JSON.stringify({ text }),
    headers: { 'Content-Type': 'application/json', ...(csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {}) } });
  if (!response.ok) throw new ApiError(((await response.json().catch(() => ({}))) as { error?: string }).error || 'La voz no responde.', response.status, {});
  return URL.createObjectURL(await response.blob());
}
export const putVoiceSettings = (changes: Partial<VoiceSettings>) => core<VoiceSettings>('/voice/settings', changes, 'PUT');
/** A short recorded clip to text, on this machine (the audio goes to the core only). */
export async function transcribeVoice(audio: Blob): Promise<{ text: string; language: string | null; seconds: number }> {
  const response = await fetch('/api/core/voice/transcribe', {
    method: 'POST', body: audio,
    headers: { 'Content-Type': audio.type || 'application/octet-stream', ...(csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || 'No se pudo transcribir.', response.status, data);
  return data;
}

/** Replying: a prefilled reply, a body drafted by Watson (normal mail only), the sealed preview and the send. */
export type MailDraft = { accountId: number; to: string; cc: string; subject: string; body: string; replyTo: number | null };
export type MailPreview = { draft: { accountId: number; to: string[]; cc: string[]; subject: string; body: string; replyTo: number | null };
  from: string; digest: string; attachments: string[] };
export const getReplyDraft = (messageId: number) => core<MailDraft>(`/mail/messages/${messageId}/reply`);
export const composeReply = (messageId: number, instructions: string) => core<{ body: string }>(`/mail/messages/${messageId}/compose`, { instructions });
export const previewMail = (draft: MailDraft) => core<MailPreview>('/mail/drafts/preview', draft);
export const sendMail = (draft: MailDraft, digest: string) => core<{ sent: boolean; savedToSent: boolean; refused: string[] }>('/mail/send', { draft, digest });

/** Recorded meetings: your microphone (sent here in pieces) and the system's audio (recorded by the core). */
export type Meeting = { id: number; title: string; confidentiality: Level; status: 'recording' | 'recorded' | 'interrupted';
  started_at: string; ended_at: string | null; seconds: number; mic_bytes: number; system_source: string | null; system_bytes: number; note: string | null;
  work: 'none' | 'transcribing' | 'summarizing' | 'done' | 'failed'; work_error: string | null; summary_by: 'claude' | 'local' | 'none' | null;
  has_transcript: boolean; saved_note: { vault: string; note: string } | null; kind: MeetingKind; client: string | null; project: string | null; people: MeetingPerson[] };
export type MeetingPerson = { name: string; email: string | null };
export type ContactMatch = { name: string; org: string | null; email: string | null };
/** People from the Mac's Contacts for «Con quién» (status: granted, denied, undetermined, unavailable…). */
export const findContacts = (q: string) => core<{ status: string; contacts: ContactMatch[] }>(`/meetings/contacts?q=${encodeURIComponent(q)}`);
export type MeetingKind = 'meeting' | 'training' | 'interview' | 'call' | 'other';
export const kindLabels: Record<MeetingKind, string> = { meeting: 'Reunión', training: 'Formación', interview: 'Entrevista', call: 'Llamada', other: 'Otra' };
export type MeetingClass = { kind: MeetingKind; client: string | null; project: string | null; people: MeetingPerson[] };
export type MeetingTask = { title: string; who: string | null; due: string | null };
export type MeetingDetail = Meeting & { transcript: { start: number; end: number; text: string; speaker: string }[];
  summary: { summary: string; topics?: { topic: string; detail: string }[]; decisions: string[]; tasks: MeetingTask[] } | null; draft: { title: string; content: string } | null };
export const getMeeting = (id: number) => core<MeetingDetail>(`/meetings/${id}`);
export const processMeeting = (id: number, summaryOnly = false) => core<Meeting>(`/meetings/${id}/process`, { summary_only: summaryOnly });
export const markMeetingSaved = (id: number, vault: string, note: string) => core<Meeting>(`/meetings/${id}/saved`, { vault, note });
export type MeetingSettings = { local_url: string | null; local_model: string | null; auto?: boolean; known?: { name: string; url: string }[]; detected?: string | null };
export const getMeetingSettings = () => core<MeetingSettings>('/meetings/settings');
export const putMeetingSettings = (changes: Partial<MeetingSettings>) => core<MeetingSettings>('/meetings/settings', changes, 'PUT');
export type Summarizer = { by: 'claude' | 'local' | 'local-off' | 'none'; label: string };
export const getSummarizers = () => core<Record<Level, Summarizer>>('/meetings/summarizers');
export const getLocalModels = (url: string) => core<{ models: string[] }>(`/meetings/local-models?url=${encodeURIComponent(url)}`);
export type MeetingList = { meetings: Meeting[]; system: string | null; recording: number | null };
export const getMeetings = () => core<MeetingList>('/meetings');
export const startMeeting = (body: { title: string; confidentiality: Level; mic_type: string; system: boolean } & Partial<MeetingClass>) => core<Meeting>('/meetings', body);
export const updateMeeting = (id: number, changes: Partial<MeetingClass> & { title?: string }) => core<Meeting>(`/meetings/${id}`, changes, 'PATCH');
/** The whole meeting as a Markdown file in Downloads (for Claude, Codex or anyone), shown in the Finder. */
export const exportMeeting = (id: number) => core<{ path: string; name: string }>(`/meetings/${id}/export`, {});
export const stopMeeting = (id: number) => core<Meeting>(`/meetings/${id}/stop`, {});
export const deleteMeeting = (id: number) => core<{ deleted: boolean }>(`/meetings/${id}`, undefined, 'DELETE');
/** One piece of the microphone, in order. */
export async function sendMeetingPiece(id: number, piece: Blob): Promise<void> {
  const response = await fetch(`/api/core/meetings/${id}/mic`, {
    method: 'POST', body: piece,
    headers: { 'Content-Type': 'application/octet-stream', ...(csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {}) },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || 'No se pudo guardar el audio.', response.status, data);
  }
}

/** Music (1.5): what Apple Music or Spotify plays, its controls and «pon …». */
export type MusicPlayer = { player: string; name: string; state: string; title?: string; artist?: string; album?: string;
  duration?: number | null; position?: number | null; volume?: number | null; problem?: string };
export type MusicState = { players: MusicPlayer[]; note: string | null };
export type MusicAction = 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'louder' | 'quieter';
export const getMusic = () => core<MusicState>('/music/status');
export const controlMusic = (player: string, action: MusicAction) => core<MusicState>('/music/control', { player, action });
/** The volume (0-100) or the point of the song (seconds) dragged to in Apple Music or Spotify. */
export const setMusicLevel = (player: string, action: 'volume' | 'seek', value: number) => core<MusicState>('/music/control', { player, action, value });
/** A cover as a local picture (the API needs its header, so an <img> cannot ask for it): null when there is none. */
async function picture(path: string): Promise<string | null> {
  const response = await fetch(`/api/core${path}`, { headers: csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {} });
  return response.status === 200 ? URL.createObjectURL(await response.blob()) : null;
}
export const libraryCover = (id: string) => picture(`/music/library/${encodeURIComponent(id)}/cover`);
export const playerCover = (player: string, key: string) => picture(`/music/cover?player=${encodeURIComponent(player)}&key=${encodeURIComponent(key)}`);
export const playMusic = (player: string, query: string) => core<MusicState & { done: string }>('/music/play', { player, query });

/** Opening apps (1.5): the installed ones, those Watson may open without asking, and opening one. */
export type InstalledApp = { id: string; name: string; aliases?: string[] };
export const getApps = () => core<{ apps: InstalledApp[]; allowed: string[] }>('/apps');
export const putAllowedApps = (allowed: string[]) => core<{ allowed: string[] }>('/apps/allowed', { allowed }, 'PUT');
export const openApp = (id: string, confirmed = false) => core<{ done: string }>('/apps/open', { id, confirmed });

/** «Oye Watson» (1.5): off by default; the desktop app starts its on-device listener while it is on. */
/** How the desktop app's «Oye Watson» listener is doing; null when no desktop app has said anything. */
export type WakeState = 'off' | 'starting' | 'listening' | 'no_speech_permission' | 'no_mic_permission' | 'no_offline' | 'mic_failed' | 'missing' | 'stopped';
export type Wake = { enabled: boolean; state: WakeState | null; attempt: number };
export const getWake = () => core<Wake>('/wake/settings');
export const putWake = (enabled: boolean) => core<Wake>('/wake/settings', { enabled }, 'PUT');

/** The user's own music (1.5): folders, search, a track to play (fetched with the CSRF header, played from
 * memory) and a YouTube search opened in the browser. */
export type LibraryTrack = { id: string; title: string; artist: string | null; album: string | null };
/** YouTube videos for «pon … en YouTube», played inside AgoraOne (only the words asked for go to YouTube). */
export type Video = { id: string; title: string; channel: string | null; length: string };
export const searchYouTube = (query: string) => core<{ videos: Video[] }>(`/music/youtube/search?q=${encodeURIComponent(query)}`);
export const getLibrary = (q = '') => core<{ folders: string[]; tracks: LibraryTrack[]; total: number }>(`/music/library?q=${encodeURIComponent(q)}`);
export const putLibraryFolders = (folders: string[]) => core<{ folders: string[] }>('/music/library/folders', { folders }, 'PUT');
export const chooseLibraryFolder = () => core<{ path: string | null }>('/music/library/choose', {});
export const openYouTube = (query: string) => core<{ done: string }>('/music/youtube', { query });
export type HiddenCommand = { action: 'play'; id: string } | { action: 'pause' | 'resume' | 'stop' } | { action: 'volume'; volume: number } | { action: 'seek'; seconds: number };
export const hiddenYouTubeAvailable = () => core<{ available: boolean }>('/music/youtube/hidden');
export const hiddenYouTube = (command: HiddenCommand) => core<{ seq: number }>('/music/youtube/hidden', command);
export async function trackUrl(id: string): Promise<string> {
  const response = await fetch(`/api/core/music/library/${encodeURIComponent(id)}/file`, { headers: csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {} });
  if (!response.ok) throw new ApiError('No se pudo abrir esa canción.', response.status, {});
  return URL.createObjectURL(await response.blob());
}

/** «Qué tengo instalado» (1.6): every piece, whether it is here, which modules use it and how to get it. */
export type DoctorHow = { kind: 'brew' | 'command' | 'page' | 'model' | 'none'; package?: string; command?: string; url?: string; model?: string; bytes?: number };
export type DoctorPiece = { id: string; name: string; state: 'ok' | 'missing' | 'optional'; modules: string[]; detail: string | null; how: DoctorHow };
export const getDoctor = () => core<{ pieces: DoctorPiece[]; platform: string; missing: number; summary: string }>('/doctor');
export type InstallJob = { id: string; name: string; state: 'running' | 'done' | 'failed'; lines: string[]; done: number; total: number; error: string | null };
export const getInstallJob = () => core<{ job: InstallJob | null }>('/doctor/install');
export const installPiece = (id: string) => core<{ job: InstallJob }>('/doctor/install', { id });
/** Modules (1.6): which are on; one off disappears, stops its background work and Watson loses its tools. */
export type ModuleName = 'correo' | 'agenda' | 'fiscal' | 'trabajos' | 'reuniones' | 'voz' | 'musica' | 'oficina' | 'orca' | 'whatsapp' | 'jev' | 'presupuestos' | 'central' | 'fabrica';
/** `owners`: the connector whose card in Conectores holds the module's switch (absent in an older core). */
export type ModulesState = { modules: Record<ModuleName, boolean>; labels: Record<ModuleName, string>; owners?: Partial<Record<ModuleName, string>> };
export const getModules = () => core<ModulesState>('/modules');
export const putModules = (modules: Partial<Record<ModuleName, boolean>>) => core<ModulesState>('/modules', { modules }, 'PUT');
export const getFirstRun = () => core<{ done: boolean }>('/setup/first-run');
export const putFirstRun = (done: boolean) => core<{ done: boolean }>('/setup/first-run', { done }, 'PUT');
/** The vault's review (1.7): what makes things hard to find; changes nothing. */
export type ReviewNote = { key: string; title: string; folder: string };
export type VaultReview = { notes: number; folders: number; root: ReviewNote[]; rootCount: number; orphans: ReviewNote[]; orphanCount: number;
  duplicates: { title: string; notes: ReviewNote[] }[]; duplicateCount: number; tiny: ReviewNote[]; tinyCount: number;
  lonelyFolders: string[]; lonelyCount: number; crowdedFolders: { folder: string; notes: number }[]; deepFolders: string[]; deepCount: number;
  secrets: ReviewNote[]; secretCount: number };
export const getVaultReview = (discreet: boolean) => core<VaultReview>(`/brain/review?discreet=${+discreet}`);
/** A GitHub issue Watson proposed for a Central project's repository, created with the user's `gh` once confirmed. */
export type ProposedIssue = { repo: string; client: string | null; project: string; title: string; body: string; meeting: string | null; visibility: 'public' | 'private' | 'internal' | null };
export const createIssueFromProposal = (id: string) => core<{ url: string; repo: string }>(`/assistant/proposals/${encodeURIComponent(id)}/issue`, {});
/** A quote Watson proposed, created in Central as a draft once confirmed (1.7). */
export type ProposedQuote = { client: string; title: string; items: { description: string; details?: string; unitPrice: number; priceMax?: number; quantity: number; unit?: string }[];
  phases?: { name: string; percent?: number }[]; vat?: number; validDays?: number };
export const createQuoteFromProposal = (id: string) => core<{ created: { id?: string; number?: string; client?: string; text?: string } }>(`/assistant/proposals/${encodeURIComponent(id)}/quote`, {});
/** Tidying the mailbox (1.7): the messages Watson listed; only the approved ones move to the archive or the trash. */
export type CleanupMessage = { id: number; from: string; address: string; subject: string; date: string | null; account: string; level: Level };
export const cleanMailFromProposal = (id: string, ids: number[]) => core<{ moved: number; problems: string[] }>(`/assistant/proposals/${encodeURIComponent(id)}/mail`, { ids });
/** Reordering the vault (1.7): one move or rename Watson proposed; `toTitle` null keeps the note's own title. */
export type ReorgMove = { n: number; source: string; ref: string; title: string; folder: string; toFolder: string; toTitle: string | null; newFolder: boolean; links: number; reason: string };

/** Orca module (1.7): Central projects already in Orca, the exact preview of a launch and the launch itself. */
export type OrcaAgent = 'claude' | 'codex';
export type OrcaProject = { client: string; project: string; repo: string };
export type OrcaSource = { kind: 'mail'; id: number } | { kind: 'issue'; url: string } | { kind: 'note'; source: string; ref: string; revision: string } | { kind: 'project' };
/** What Watson proposes to take to Orca: it only opens the card, which still needs the preview and «Lanzar en Orca». */
export type OrcaProposal = OrcaProject & { task: string; agent: OrcaAgent; issue: string | null };
export type OrcaPreview = { id: string; client: string; project: string; repo: string; orcaName: string; agent: OrcaAgent; agentName: string; name: string;
  source: { kind: string; label: string; number?: number; url?: string } | null; sourceText: string | null; prompt: string };
export const getOrcaProjects = () => core<{ projects: OrcaProject[]; problem: string | null }>('/orca/projects');
export const previewOrca = (request: { client: string; project: string; task: string; agent: OrcaAgent; source?: OrcaSource }) => core<OrcaPreview>('/orca/preview', request);
export type MailSources = { attachments: { part: number; name: string; type: string; bytes: number; savable: boolean }[]; links: { url: string; service: string; downloadable: boolean }[] };
export const getMailSources = (id: number) => core<MailSources>(`/mail/inbox/${id}/sources`);
export type MailFile = { kind: 'attachment'; part: number } | { kind: 'link'; url: string };
/** One attachment or ticked shared document of a mail, as bytes for the vault's own writer. */
export async function fetchMailFile(id: number, source: MailFile): Promise<{ name: string; data: Blob }> {
  const response = await fetch(`/api/core/mail/inbox/${id}/file`, { method: 'POST', body: JSON.stringify(source),
    headers: { 'Content-Type': 'application/json', ...(csrfToken() ? { 'X-Agora-CSRF': csrfToken() } : {}) } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'No se pudo traer el archivo.');
  const disposition = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1];
  return { name: disposition ? decodeURIComponent(disposition) : 'documento', data: await response.blob() };
}
export const saveRepoFile = (body: MailFile & { client: string; project: string; folder: string; name: string; prefix: string; inboxId: number }) =>
  core<{ path: string }>('/orca/repo-file', body);
export const getIssueTarget = (client: string, project: string) =>
  core<{ repo: string | null; visibility: 'public' | 'private' | 'internal' | null }>(`/issues/target?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
export type IssueSource = { kind: 'mail'; id: number } | { kind: 'note'; source: string; ref: string; revision: string };
export const createIssue = (issue: { client: string; project: string; title: string; body: string; source: IssueSource }) => core<{ repo: string; url: string }>('/issues', issue);
export type WaitingSession = { id: string; tool: 'claude' | 'codex'; project: string | null; branch: string | null; model: string | null; lastAt: string | null };
export const getWaitingSessions = (repo: string, url: string) =>
  core<{ sessions: WaitingSession[]; line: string | null }>(`/orca/waiting?repo=${encodeURIComponent(repo)}&url=${encodeURIComponent(url)}`);
export const handoffIssue = (repo: string, url: string, session: string) => core<{ line: string }>('/orca/handoff', { repo, url, session });
export type RepoFolders = { repo: string; root: string; folders: string[]; suggested: string; visibility: 'public' | 'private' | 'internal' | null };
export const getRepoFolders = (client: string, project: string) => core<RepoFolders>(`/orca/repo-folders?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
export const createRepoNote = (note: { client: string; project: string; folder: string; title: string; content: string; inboxId: number }) =>
  core<{ repo: string; root: string; path: string }>('/orca/repo-note', note);
export const launchOrca = (id: string) => core<{ name: string; surface: 'chat' | 'terminal' | null; repo: string; agentName: string }>('/orca/launch', { id });
