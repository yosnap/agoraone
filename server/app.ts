import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Conversations } from './conversations';
import { hermesReply, readiness, type Adapter } from './hermes-adapter';
import { Library, LibraryError } from './library';
import { PrivateLibrary, renameSchema } from './private-library';
import { extractUpload, uploadSchema } from './document-extraction';
import { HermesDiscovery } from './hermes-catalog';
import { profileContext, ProfileContextError } from './profile-context';
import { obsidianVaults } from './resource-discovery';
import { VaultError } from './vault-notes';
import { BackgroundReads } from './background-reads';
import { maskSecrets } from './secret-lines';

export function createApp(options: { directory?: string; adapter?: Adapter; libraryRoot?: string; privateLibraryRoot?: string; discovery?: HermesDiscovery; obsidianRegistry?: string | null; reads?: BackgroundReads } = {}) {
  const app = express();
  const store = new Conversations(options.directory || resolve('.agora/conversations'));
  const adapter = options.adapter || hermesReply;
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
  const discovery = options.discovery || new HermesDiscovery();
  const busy = new Set<string>();
  const hosts = new Set(['127.0.0.1:4317', '127.0.0.1:5173']);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host || '')) return res.status(403).json({ error: 'Host no permitido.' });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return res.status(403).json({ error: 'Origen no permitido.' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
  app.post('/api/library/imports', express.json({ limit: '7mb' }), async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Elige TXT, Markdown, PDF o DOCX. No se permiten rutas ni campos adicionales.' });
    let extracted;
    try { extracted = await extractUpload(parsed.data); }
    catch (error) { return res.status(400).json({ error: /\.(pdf|docx)$/i.test(parsed.data.name) && error instanceof Error ? error.message : 'Texto no válido. Usa UTF-8 y un máximo de 24 KiB.' }); }
    try { res.status(201).json(privateLibrary.import(extracted, res.locals.owner)); }
    catch { res.status(400).json({ error: 'No se pudo guardar la copia. Comprueba el límite de 100 documentos.' }); }
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/status', (_req, res) => res.json({ ...readiness(), csrf }));
  app.use('/api/hermes', (req, res, next) => {
    if (req.headers['x-agora-csrf'] !== csrf) return res.status(403).json({ error: 'Recarga AgoraOne para acceder al catálogo local.' });
    next();
  });
  app.get('/api/hermes/catalog', (_req, res) => {
    try { const catalog = discovery.scan(); const obsidian = obsidianVaults(options.obsidianRegistry);
      res.json({ ...catalog, vaults: obsidian.vaults, warnings: [...catalog.warnings, ...obsidian.warnings] }); }
    catch { res.status(503).json({ error: 'No se pudo leer el catálogo de Hermes.' }); }
  });
  // Obsidian notes: read-only, opaque IDs resolved against a fresh walk of the registered vault.
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
    try {
      // The profile is validated before any attachment is read, so a revoked profile reads nothing.
      const profile = data.profileId ? profileContext(discovery, data.profileId) : undefined;
      if (profile && profile.agentId !== data.agent) throw new ProfileContextError();
      const document = parsed.data.documentId ? await readAttachment(parsed.data.documentId, res.locals.owner) : undefined;
      if (streaming) { res.type('application/x-ndjson'); res.flushHeaders(); emit({ type: 'status', stage: 'starting' }); }
      const reply = await adapter({ sessionId: data.hermesSessionId, message: parsed.data.message, history: data.messages, document, profile }, streaming ? emit : undefined);
      const sources = document ? [{ id: document.id, title: document.title, revision: document.revision }] : undefined;
      const identity = profile ? { profileId: profile.id, files: profile.files.map(({ name, revision }) => ({ name, revision })) } : undefined;
      data.messages.push({ role: 'user', content: parsed.data.message, ...(sources ? { sources } : {}), ...(identity ? { identity } : {}) }, { role: 'assistant', content: reply });
      store.save(data);
      const result = { id: data.id, messages: data.messages, profileId: data.profileId, source: 'hermes' };
      if (streaming) { emit({ type: 'done', conversation: result }); res.end(); }
      else res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo conversar con Hermes.';
      if (res.headersSent) { emit({ type: 'error', error: message }); res.end(); }
      else res.status(error instanceof LibraryError || error instanceof VaultError || error instanceof ProfileContextError ? 403 : 502).json({ error: message });
    } finally { busy.delete(data.id); }
  });
  app.use(express.static(resolve('dist')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : error instanceof SyntaxError ? 400 : 500).json({ error: tooLarge ? 'El archivo o la solicitud supera el tamaño permitido.' : 'No se pudo procesar la solicitud.' });
  });
  return app;
}
