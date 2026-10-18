import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Conversations } from './conversations';
import { hermesReply, readiness, type Adapter } from './hermes-adapter';
import { agentReply, answerApproval, cancelTurn } from './hermes-agent-adapter';
import type { Progress } from './hermes-worker';
import { Library, LibraryError } from './library';
import { PrivateLibrary, renameSchema } from './private-library';
import { extractUpload, uploadSchema } from './document-extraction';
import { HermesDiscovery } from './hermes-catalog';
import { profileContext, ProfileContextError } from './profile-context';
import { obsidianVaults } from './resource-discovery';
import { VaultError, VaultWriteError } from './vault-notes';
import { BackgroundReads } from './background-reads';
import { maskSecrets } from './secret-lines';
import { backupMemories, ProfileEditError, saveProfileFile } from './profile-editor';
import { jobDetail, manageCard, manageJob, ManageError } from './hermes-manage';
import { callMcpTool, McpCallError } from './mcp-call';
import { accessCookie, accessProof, loadAccessToken, sameSecret } from './access-token';

export function createApp(options: { directory?: string; adapter?: Adapter; profileAdapter?: Adapter; libraryRoot?: string; privateLibraryRoot?: string; discovery?: HermesDiscovery; obsidianRegistry?: string | null; reads?: BackgroundReads; backups?: string; vaultBackups?: string; accessToken?: string } = {}) {
  const app = express();
  // No other site may frame AgoraOne (clickjacking): neither the page nor the API.
  app.use((_req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); next(); });
  const store = new Conversations(options.directory || resolve('.agora/conversations'));
  const adapter = options.adapter || hermesReply;
  // Profiles run their own agent with tools; tests that inject one adapter use it for both.
  const profileAdapter = options.profileAdapter || options.adapter || agentReply;
  const library = new Library(options.libraryRoot);
  const privateLibrary = new PrivateLibrary(options.privateLibraryRoot);
  // Heavy synchronous reads (Hermes SQLite, vault files) run in a worker so requests never stall.
  const reads = options.reads || new BackgroundReads(options.obsidianRegistry);
  const readDocument = (id: string, owner: string) => id.startsWith('import-') ? privateLibrary.read(id, owner) : library.read(id);
  // Notes are attached only when sending a message (CSRF-protected); the library route never resolves them.
  // Whatever the source, credential-like lines are hidden before an attachment reaches the model.
  const readAttachment = async (id: string, owner: string) => {
    const document = id.startsWith('note-') ? await reads.vaultDocument(id) : readDocument(id, owner);
    return { ...document, content: maskSecrets(document.content).text };
  };
  const csrf = randomBytes(32).toString('hex');
  const proof = accessProof(options.accessToken ?? loadAccessToken());
  const discovery = options.discovery || new HermesDiscovery();
  const backups = options.backups || resolve('.agora/profile-backups');
  const busy = new Set<string>(), stopped = new Set<string>();
  const hosts = new Set(['127.0.0.1:4317', '127.0.0.1:5173']);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host || '')) return res.status(403).json({ error: 'Host no permitido.' });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return res.status(403).json({ error: 'Origen no permitido.' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The browser proves once that it holds the access token (see server/access-token.ts).
    if (req.path === '/api/session' && req.method === 'POST') return next();
    const cookieProof = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${accessCookie}=([a-f0-9]{64})(?:;|$)`))?.[1];
    if (req.path.startsWith('/api') && !sameSecret(cookieProof, proof))
      return res.status(401).json({ error: 'Abre AgoraOne con el enlace de acceso: lo muestra «npm run dev» al arrancar, o usa «npm run open».' });
    if (req.path.startsWith('/api') && req.method !== 'GET' &&
      (!origin || req.headers['x-agora-csrf'] !== csrf)) {
      return res.status(403).json({ error: 'Sesión de navegador no válida. Recarga la página.' });
    }
    let token = req.headers.cookie?.match(/(?:^|;\s*)agora_user=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token) {
      token = randomBytes(32).toString('hex');
      res.cookie('agora_user', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 30 * 86400_000 });
    }
    res.locals.owner = createHash('sha256').update(token).digest('hex');
    next();
  });
  app.post('/api/session', express.json({ limit: '1kb' }), (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : undefined;
    // Only from AgoraOne's own page (Origin is checked above and required here) and with the exact token.
    if (!req.headers.origin || !token || !sameSecret(accessProof(token), proof)) return res.status(403).json({ error: 'Enlace de acceso no válido.' });
    res.cookie(accessCookie, proof, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 365 * 86400_000 });
    res.status(204).end();
  });
  app.post('/api/library/imports', express.json({ limit: '7mb' }), async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Elige TXT, Markdown, PDF o DOCX. No se permiten rutas ni campos adicionales.' });
    let extracted;
    try { extracted = await extractUpload(parsed.data); }
    catch (error) { return res.status(400).json({ error: /\.(pdf|docx)$/i.test(parsed.data.name) && error instanceof Error ? error.message : 'Texto no válido. Usa UTF-8 y un máximo de 24 KiB.' }); }
    try { res.status(201).json(privateLibrary.import(extracted, res.locals.owner)); }
    catch { res.status(400).json({ error: 'No se pudo guardar la copia. Comprueba el límite de 100 documentos.' }); }
  });
  // Editing a profile writes its real Hermes files (user's decision, 18/10/2026): CSRF-protected like every
  // mutation, with backup, conflict check and Hermes' memory lock in profile-editor.ts.
  app.put('/api/hermes/profiles/:id/files/:name', express.json({ limit: '256kb' }), async (req, res) => {
    const name = z.enum(['SOUL.md', 'MEMORY.md', 'USER.md']).safeParse(req.params.name);
    const body = z.object({
      content: z.string().max(70_000).optional(), entries: z.array(z.string().max(70_000)).max(500).optional(),
      revision: z.string().regex(/^[a-f0-9]{24}$/).nullable(), revealed: z.boolean().optional(),
    }).strict().safeParse(req.body);
    if (!name.success || !body.success) return res.status(400).json({ error: 'Edición no válida.' });
    try { res.json(await saveProfileFile(discovery, backups, req.params.id, name.data, body.data)); }
    catch (error) { res.status(error instanceof ProfileEditError ? error.status : 500).json({ error: error instanceof ProfileEditError ? error.message : 'No se pudo guardar el archivo en Hermes.' }); }
  });
  // Editing the vault writes the user's real Obsidian notes (user's decision, 18/10/2026): CSRF-protected,
  // revision-checked and backed up first; only notes found by a fresh walk of a registered vault.
  const vaultBackups = options.vaultBackups || resolve('.agora/vault-backups');
  const vaultWrite = (res: express.Response, error: unknown) => error instanceof VaultWriteError ? res.status(error.status).json({ error: error.message })
    : res.status(error instanceof VaultError ? 404 : 500).json({ error: error instanceof VaultError ? error.message : 'No se pudo guardar la nota.' });
  app.put('/api/hermes/vaults/:id/notes/:noteId', express.json({ limit: '384kb' }), async (req, res) => {
    const body = z.object({ content: z.string().max(300_000), revision: z.string().regex(/^[a-f0-9]{64}$/), revealed: z.boolean().optional() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Contenido no válido.' });
    try { res.json(await reads.vaultSave(req.params.id, req.params.noteId, body.data, vaultBackups)); } catch (error) { vaultWrite(res, error); }
  });
  app.post('/api/hermes/vaults/:id/notes', express.json({ limit: '384kb' }), async (req, res) => {
    const body = z.object({ folder: z.string().max(1000), title: z.string().max(200), content: z.string().max(300_000) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Datos de la nota no válidos.' });
    try { res.status(201).json(await reads.vaultCreate(req.params.id, body.data.folder, body.data.title, body.data.content)); } catch (error) { vaultWrite(res, error); }
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/status', (_req, res) => res.json({ ...readiness(), csrf }));
  app.use('/api/hermes', (req, res, next) => {
    if (req.headers['x-agora-csrf'] !== csrf) return res.status(403).json({ error: 'Recarga AgoraOne para acceder al catálogo local.' });
    next();
  });
  // Scheduled tasks and kanban cards of a profile (user's decision, 18/10/2026): Hermes' own functions, CSRF,
  // strict bodies, and only what belongs to that profile. Nothing starts an agent from here.
  const manageFail = (res: express.Response, error: unknown) => res.status(error instanceof ManageError ? error.status : 500)
    .json({ error: error instanceof ManageError ? error.message : 'No se pudo completar la operación.' });
  const profileParam = z.string().regex(/^profile-[a-f0-9]{24}$/), itemParam = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
  const jobFields = { name: z.string().trim().min(1).max(100), schedule: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(4000) };
  app.get('/api/hermes/profiles/:id/jobs/:jobId', async (req, res) => {
    if (!profileParam.safeParse(req.params.id).success || !itemParam.safeParse(req.params.jobId).success) return res.status(404).json({ error: 'Tarea no disponible.' });
    try { res.json(await jobDetail(discovery, req.params.id, req.params.jobId)); } catch (error) { manageFail(res, error); }
  });
  app.post('/api/hermes/profiles/:id/jobs', async (req, res) => {
    const body = z.object(jobFields).strict().safeParse(req.body);
    if (!profileParam.safeParse(req.params.id).success) return res.status(404).json({ error: 'Perfil no disponible.' });
    if (!body.success) return res.status(400).json({ error: 'Indica nombre, horario e instrucciones de la tarea.' });
    try { res.status(201).json(await manageJob(discovery, req.params.id, null, body.data)); } catch (error) { manageFail(res, error); }
  });
  app.post('/api/hermes/profiles/:id/jobs/:jobId', async (req, res) => {
    const body = z.union([
      z.object({ action: z.enum(['pause', 'resume', 'run', 'remove']) }).strict(),
      z.object({ action: z.literal('update'), ...jobFields, revision: z.string().regex(/^[a-f0-9]{24}$/) }).partial({ name: true, schedule: true, prompt: true, revision: true }).strict()
        .refine(body => body.prompt === undefined || body.revision !== undefined),
    ]).safeParse(req.body);
    if (!profileParam.safeParse(req.params.id).success || !itemParam.safeParse(req.params.jobId).success) return res.status(404).json({ error: 'Tarea no disponible.' });
    if (!body.success) return res.status(400).json({ error: 'Operación no válida.' });
    try { res.json(await manageJob(discovery, req.params.id, req.params.jobId, body.data)); } catch (error) { manageFail(res, error); }
  });
  app.post('/api/hermes/profiles/:id/cards', async (req, res) => {
    const body = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(4000).optional() }).strict().safeParse(req.body);
    if (!profileParam.safeParse(req.params.id).success) return res.status(404).json({ error: 'Perfil no disponible.' });
    if (!body.success) return res.status(400).json({ error: 'Indica un título de hasta 200 caracteres.' });
    try { res.status(201).json(await manageCard(discovery, req.params.id, null, body.data)); } catch (error) { manageFail(res, error); }
  });
  app.post('/api/hermes/profiles/:id/cards/:cardId', async (req, res) => {
    const body = z.union([
      z.object({ action: z.enum(['complete', 'unblock', 'archive']) }).strict(),
      z.object({ action: z.literal('block'), reason: z.string().max(500).optional() }).strict(),
      z.object({ action: z.literal('comment'), body: z.string().trim().min(1).max(4000) }).strict(),
    ]).safeParse(req.body);
    if (!profileParam.safeParse(req.params.id).success || !itemParam.safeParse(req.params.cardId).success) return res.status(404).json({ error: 'Tarjeta no disponible.' });
    if (!body.success) return res.status(400).json({ error: 'Operación no válida.' });
    try { res.json(await manageCard(discovery, req.params.id, req.params.cardId, body.data)); } catch (error) { manageFail(res, error); }
  });
  app.get('/api/hermes/catalog', (_req, res) => {
    try { const catalog = discovery.scan(); const obsidian = obsidianVaults(options.obsidianRegistry);
      res.json({ ...catalog, vaults: obsidian.vaults, warnings: [...catalog.warnings, ...obsidian.warnings] }); }
    catch { res.status(503).json({ error: 'No se pudo leer el catálogo de Hermes.' }); }
  });
  // Obsidian notes: opaque IDs resolved against a fresh walk of the registered vault (writes further below).
  app.get('/api/hermes/vaults/:id/notes', async (req, res) => {
    try { res.json(await reads.vaultList(req.params.id)); }
    catch { res.status(404).json({ error: 'Vault no disponible.' }); }
  });
  app.get('/api/hermes/vaults/:id/notes/:noteId', async (req, res) => {
    try { res.json(await reads.vaultRead(req.params.id, req.params.noteId, req.query.reveal === '1')); }
    catch { res.status(404).json({ error: 'Nota no disponible: puede ser demasiado grande, no ser texto UTF-8 o haber cambiado.' }); }
  });
  app.get('/api/hermes/vaults/:id/search', async (req, res) => {
    const query = z.string().trim().min(2).max(100).safeParse(req.query.q);
    if (!query.success) return res.status(400).json({ error: 'Escribe entre 2 y 100 caracteres.' });
    try { res.json(await reads.vaultSearch(req.params.id, query.data)); }
    catch { res.status(404).json({ error: 'Vault no disponible.' }); }
  });
  app.get('/api/hermes/activity', async (_req, res) => {
    try { const { root, profiles } = discovery.activityTargets(); res.json(await reads.activity(root, profiles)); }
    catch { res.status(503).json({ error: 'No se pudo leer la actividad de Hermes.' }); }
  });
  app.get('/api/hermes/profiles/:id', (req, res) => {
    // ?reveal=1 shows hidden credential-like lines. Stays under /api/hermes, whose middleware requires the CSRF header on GET too.
    try { res.json(discovery.detail(req.params.id, req.query.reveal === '1')); }
    catch { res.status(404).json({ error: 'Perfil no disponible para lectura.' }); }
  });
  app.get('/api/hermes/profiles/:id/mcp/:serverId/tools', (req, res) => {
    try { res.json(discovery.mcpTools(req.params.id, req.params.serverId)); }
    catch { res.status(404).json({ error: 'Servidor MCP no disponible en este perfil.' }); }
  });
  // One MCP tool called by hand with the arguments the user confirmed (user's decision, 18/10/2026).
  app.post('/api/hermes/profiles/:id/mcp/:serverId/tools/:tool/call', async (req, res) => {
    const body = z.object({ args: z.record(z.string().max(200), z.unknown()) }).strict().safeParse(req.body);
    if (!body.success || req.params.tool.length > 200) return res.status(400).json({ error: 'Argumentos no válidos.' });
    try { res.json(await callMcpTool(discovery, req.params.id, req.params.serverId, req.params.tool, body.data.args)); }
    catch (error) { res.status(error instanceof McpCallError ? error.status : 500).json({ error: error instanceof McpCallError ? error.message : 'No se pudo completar la llamada.' }); }
  });
  // Shared demonstration resource for local browser identities; no personal collections.
  app.get('/api/library/documents', (_req, res) => res.json({ resourceId: 'library-test', permissions: ['read'], documents: [
    ...library.list().map(item => ({ ...item, kind: 'example' })), ...privateLibrary.list(res.locals.owner),
  ] }));
  app.get('/api/library/documents/:id', (req, res) => {
    try { res.json(readDocument(req.params.id, res.locals.owner)); }
    catch { res.status(404).json({ error: 'Documento no disponible o fuera de los permisos de lectura.' }); }
  });
  app.patch('/api/library/documents/:id', (req, res) => {
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Escribe un nombre de 1 a 160 caracteres, sin rutas.' });
    try { res.json(privateLibrary.rename(req.params.id, res.locals.owner, parsed.data)); }
    catch { res.status(404).json({ error: 'No se puede renombrar esta copia. No existe o no te pertenece.' }); }
  });
  app.delete('/api/library/documents/:id', (req, res) => {
    try { privateLibrary.delete(req.params.id, res.locals.owner); res.json({ deleted: req.params.id }); }
    catch { res.status(404).json({ error: 'No se puede eliminar esta copia. No existe o no te pertenece.' }); }
  });
  app.use('/api/library', (_req, res) => res.status(405).json({ error: 'Operación no disponible en la biblioteca.' }));
  app.post('/api/conversations', (req, res) => {
    const parsed = z.union([
      z.object({ agent: z.literal('luma'), context: z.literal('library-lobby') }).strict(),
      z.object({ profileId: z.string().regex(/^profile-[a-f0-9]{24}$/) }).strict(),
    ]).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Selecciona Luma o un perfil detectado. No se admiten instrucciones, herramientas ni configuración de ejecución.' });
    try {
      const profile = 'profileId' in parsed.data ? profileContext(discovery, parsed.data.profileId) : undefined;
      const data = store.create(res.locals.owner, profile);
      res.status(201).json({ id: data.id, messages: data.messages, profileId: data.profileId });
    } catch { res.status(403).json({ error: new ProfileContextError().message }); }
  });
  app.get('/api/conversations/:id', (req, res) => {
    const data = store.get(req.params.id, res.locals.owner);
    if (!data) return res.status(404).json({ error: 'Conversación no disponible.' });
    res.json({ id: data.id, messages: data.messages, profileId: data.profileId });
  });
  app.post('/api/conversations/:id/messages', async (req, res) => {
    const data = store.get(req.params.id, res.locals.owner);
    if (!data) return res.status(404).json({ error: 'Conversación no disponible.' });
    const parsed = z.object({ message: z.string().trim().min(1).max(6000), documentId: z.string().max(64).optional() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Escribe entre 1 y 6000 caracteres.' });
    if (busy.size >= 2 || busy.has(data.id)) return res.status(409).json({ error: 'Hay una respuesta en curso. Espera antes de continuar.' });
    if (data.messages.reduce((sum, m) => sum + m.content.length, 0) > 60_000)
      return res.status(409).json({ error: 'Esta conversación llegó a su límite. Abre una nueva.' });
    busy.add(data.id);
    const streaming = req.headers.accept === 'application/x-ndjson';
    const emit = (event: unknown) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
    // Names of the tools the profile used in this turn, kept with its answer (never their arguments or results).
    const used = new Set<string>();
    const progress = (event: Progress) => { if (event.type === 'tool' && event.state === 'end') used.add(event.name); if (streaming) emit(event); };
    try {
      // The profile is validated before any attachment is read, so a revoked profile reads nothing.
      const profile = data.profileId ? profileContext(discovery, data.profileId) : undefined;
      if (profile && profile.agentId !== data.agent) throw new ProfileContextError();
      const document = parsed.data.documentId ? await readAttachment(parsed.data.documentId, res.locals.owner) : undefined;
      // The profile's own agent may update its memory (after the user allows it): copy it first.
      if (profile && (options.profileAdapter || !options.adapter)) backupMemories(discovery, backups, profile.id);
      if (streaming) { res.type('application/x-ndjson'); res.flushHeaders(); emit({ type: 'status', stage: 'starting' }); }
      const reply = await (profile ? profileAdapter : adapter)({ sessionId: data.hermesSessionId, message: parsed.data.message, history: data.messages, document, profile }, progress);
      const sources = document ? [{ id: document.id, title: document.title, revision: document.revision }] : undefined;
      const identity = profile ? { profileId: profile.id, files: profile.files.map(({ name, revision }) => ({ name, revision })) } : undefined;
      data.messages.push({ role: 'user', content: parsed.data.message, ...(sources ? { sources } : {}), ...(identity ? { identity } : {}) }, { role: 'assistant', content: maskSecrets(reply).text, ...(used.size ? { tools: [...used].slice(0, 30) } : {}) });
      store.save(data);
      const result = { id: data.id, messages: data.messages, profileId: data.profileId, source: 'hermes' };
      if (streaming) { emit({ type: 'done', conversation: result }); res.end(); }
      else res.json(result);
    } catch (error) {
      // Only messages written for the user are shown; anything else (e.g. a file-system error with a path) is generic.
      const known = error instanceof LibraryError || error instanceof VaultError || error instanceof ProfileContextError || (error instanceof Error && !/\/|\\|ENOENT|EACCES|EPERM|errno/i.test(error.message));
      const reason = known && error instanceof Error ? error.message : 'No se pudo conversar con Hermes.';
      // Tools that already ran are not undone by a failed turn: say which, so a retry does not repeat them blindly.
      const message = stopped.has(data.id) ? `Turno detenido.${used.size ? ` Antes de detenerlo usó: ${[...used].join(', ')}.` : ''}`
        : used.size ? `El turno no terminó, pero antes usó: ${[...used].join(', ')}. Revisa el resultado antes de reintentar.` : reason;
      if (res.headersSent) { emit({ type: 'error', error: message }); res.end(); }
      else res.status(error instanceof LibraryError || error instanceof VaultError || error instanceof ProfileContextError ? 403 : 502).json({ error: message });
    } finally { busy.delete(data.id); stopped.delete(data.id); }
  });
  // Stops this conversation's running turn (owner only): pending actions are denied, the agent interrupted.
  app.post('/api/conversations/:id/cancel', (req, res) => {
    const data = store.get(req.params.id, res.locals.owner);
    if (!data || !data.profileId || !busy.has(data.id) || !cancelTurn(data.hermesSessionId)) return res.status(404).json({ error: 'No hay ningún turno en curso.' });
    stopped.add(data.id);
    res.json({ cancelled: data.id });
  });
  // The user's answer to a tool call a profile wants to make in this conversation (owner only).
  app.post('/api/conversations/:id/approvals/:requestId', (req, res) => {
    const data = store.get(req.params.id, res.locals.owner);
    const parsed = z.object({ choice: z.enum(['once', 'deny']) }).strict().safeParse(req.body);
    if (!data || !data.profileId || !/^[a-f0-9]{32}$/.test(req.params.requestId)) return res.status(404).json({ error: 'No hay ninguna acción pendiente.' });
    if (!parsed.success) return res.status(400).json({ error: 'Respuesta no válida.' });
    if (!answerApproval(data.hermesSessionId, req.params.requestId, parsed.data.choice)) return res.status(404).json({ error: 'Esta acción ya no está pendiente.' });
    res.json({ answered: req.params.requestId, choice: parsed.data.choice });
  });
  app.use(express.static(resolve('dist')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : error instanceof SyntaxError ? 400 : 500).json({ error: tooLarge ? 'El archivo o la solicitud supera el tamaño permitido.' : 'No se pudo procesar la solicitud.' });
  });
  return app;
}
