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
  | { kind: 'tool'; tool: 'inbox'; filter: string; count: number }
  | { kind: 'tool'; tool: 'clients'; filter: string; count: number }
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
export type MailProvider = 'gmail' | 'icloud' | 'microsoft' | 'other';
export type MailPreset = { name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; hint: string };
export type MailAccount = {
  id: number; address: string; label: string | null; provider: MailProvider; auth: 'password' | 'microsoft'; username: string; imapHost: string; imapPort: number;
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
  attachments: number; announcedAt: string | null; client: { name: string; projects: string[] } | null;
};
export type InboxCounts = { pending: number; done: number; dismissed: number; unread: number; since: string | null };
export const getInbox = (state: InboxState = 'pending') => core<{ items: InboxItem[]; counts: InboxCounts; problem: string | null }>(`/mail/inbox?state=${state}`);
export const archiveAllInbox = () => core<{ archived: number; counts: InboxCounts }>('/mail/inbox/archive-all', {});
export const decideInbox = (id: number, state: InboxState) => core<{ ok: true }>(`/mail/inbox/${id}`, { state }, 'PUT');
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
export type Invoice = InvoiceFields & { id: number; direction: 'received' | 'issued'; messageId: number | null; doubts: string[]; quarter: string; path: string };
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
export type UploadState = { open: boolean; url?: string; qr?: string; expiresAt?: number; received?: number | null };
export type Receipt = { id: number; name: string | null; mediaType: string; bytes: number; fields: Partial<InvoiceFields>; uploadedAt: string };
export const openUpload = () => core<UploadState>('/fiscal/receipts/upload', {});
export const getUpload = () => core<UploadState>('/fiscal/receipts/upload');
export const closeUpload = () => core<UploadState>('/fiscal/receipts/upload', undefined, 'DELETE');
export const getReceipts = () => core<{ receipts: Receipt[] }>('/fiscal/receipts');
export const dismissReceipt = (id: number) => core<{ receipts: Receipt[] }>(`/fiscal/receipts/${id}`, { state: 'dismissed' }, 'PUT');
export const fileReceipt = (id: number, folderId: number, category: Category | null, fields: InvoiceFields) =>
  core<{ id: number; path: string }>(`/fiscal/receipts/${id}/file`, { folderId, category, fields });
export const getQonto = () => core<{ login: string | null; hasKey: boolean }>('/fiscal/qonto');
export const putQonto = (changes: { login?: string | null; secret?: string | null }) => core<{ login: string | null; hasKey: boolean }>('/fiscal/qonto', changes, 'PUT');
export const checkQonto = () => core<{ name: string | null; accounts: number }>('/fiscal/qonto/check', {});
export type IncomeRow = { date: string; number: string; client: string; taxId: string; concept: string; base: number | null; vatRate: number | null;
  withholdingRate: number | null; withholding: number | null; total: number | null; currency: string };
export type FiscalIssue = { key: string; text: string; items: { label: string; detail: string; path?: string | null; qonto?: string }[] };
export type QuarterView = { folder: FiscalFolder; income: IncomeRow[]; incomeProblem: string | null; expenses: Invoice[]; notes: string[]; issues: FiscalIssue[]; reading: number; readingTotal: number };
export const downloadFromQonto = (folderId: number, year: number, quarter: number, numbers: string[]) =>
  core<{ saved: { number: string; path: string }[]; failed: { number: string; error: string }[] }>(`/fiscal/folders/${folderId}/qonto-download`, { year, quarter, numbers });
export const getQuarter = (folderId: number, year: number, quarter: number) => core<QuarterView>(`/fiscal/folders/${folderId}/quarter?year=${year}&quarter=${quarter}`);
export const makeQuarterExcel = (folderId: number, year: number, quarter: number) => core<{ path: string }>(`/fiscal/folders/${folderId}/excel`, { year, quarter });
export const openFiscalFile = (folderId: number, path: string | null, reveal = false) => core<{ ok: true }>(`/fiscal/folders/${folderId}/open`, { path, reveal });
export type CentralClient = { name: string; company: string | null; domains: string[];
  projects: { name: string; status: string; phase: string | null }[]; websites: { url: string; status: string | null }[] };
export type CentralServer = { name: string; status: string | null; provider: string | null; projects: string[] };
export type CentralState = { configured: boolean; snapshot: { clients: CentralClient[]; servers: CentralServer[]; fetchedAt: string } | null; problem: string | null };
export const getCentral = () => core<CentralState>('/central');
export const refreshCentral = () => core<CentralState>('/central/refresh', {});
export const getFiscalReading = () => core<{ withClaude: boolean }>('/fiscal/reading');
export const putFiscalReading = (withClaude: boolean) => core<{ withClaude: boolean }>('/fiscal/reading', { withClaude }, 'PUT');
