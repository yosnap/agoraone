import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, symlinkSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from './app';
import type { Adapter, Turn } from './hermes-adapter';
import { pdfFixture, docxFixture } from './document-fixtures';
import { HermesDiscovery } from './hermes-catalog';
import { mcpFingerprint } from './mcp-tools';
import { obsidianVaults } from './resource-discovery';
import { BackgroundReads } from './background-reads';

test('consulta de herramientas MCP exige CSRF, servidor del perfil y registro vigente', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-mcp-api-')));
  mkdirSync(join(root, 'cache'));
  writeFileSync(join(root, 'config.yaml'), 'mcp_servers:\n  demo:\n    command: test-only\n');
  writeFileSync(join(root, 'cache/mcp_schema_cache.json'), JSON.stringify({ demo: { fingerprint: mcpFingerprint({ command: 'test-only' }), tools: [{ name: 'test_tool' }] } }));
  const discovery = new HermesDiscovery({ root, installation: '/absent', python: '', source: 'test' });
  const profile = discovery.scan().profiles[0];
  const f = await fixture(async () => { throw new Error('No debe invocar inferencia'); }, undefined, discovery);
  const url = `/api/hermes/profiles/${profile.id}/mcp/${profile.mcp![0].id}/tools`;
  try {
    // Calling a tool by hand: CSRF, strict body, only tools of the saved catalogue and only declared servers.
    const call = `${url}/test_tool/call`;
    assert.equal((await f.request(call, { args: {} }, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request(call, { args: {}, server: '/bin/sh' })).status, 400);
    assert.equal((await f.request(`${url}/otra/call`, { args: {} })).status, 404, 'fuera del catálogo');
    assert.equal((await f.request(call.replace(profile.mcp![0].id, 'mcp-x'), { args: {} })).status, 404);
    assert.equal((await f.request(url, undefined, { 'X-Agora-CSRF': '' })).status, 403);
    const response = await f.request(url);
    assert.equal(response.status, 200); assert.equal((await response.json()).tools[0].name, 'test_tool');
    assert.equal((await f.request(url.replace(profile.id, 'profile-other'))).status, 404);
    writeFileSync(join(root, 'config.yaml'), 'mcp_servers: {}');
    assert.equal((await f.request(url)).status, 404);
  } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test('streaming: eventos, resultado definitivo y fallo sin guardar texto parcial', async () => {
  let fail = false;
  const f = await fixture(async (_turn, progress) => {
    progress?.({ type: 'status', stage: 'generating' });
    progress?.({ type: 'delta', text: 'Texto parcial' });
    if (fail) throw new Error('Fallo de prueba');
    return 'Respuesta completa';
  });
  try {
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const path = `/api/conversations/${id}/messages`;
    const headers = { Accept: 'application/x-ndjson' };
    const response = await f.request(path, { message: 'hola' }, headers);
    assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[2].text, 'Texto parcial');
    assert.equal(events.at(-1).conversation.messages[1].content, 'Respuesta completa');
    fail = true;
    const failed = await f.request(path, { message: 'fallará' }, headers);
    const failure = (await failed.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(failure.at(-1).type, 'error');
    const history = await (await f.request(`/api/conversations/${id}`)).json();
    assert.equal(history.messages.length, 2);
    assert.equal((await f.request(path, { message: 'ajeno' }, { ...headers, Cookie: `agora_user=${'f'.repeat(64)}` })).status, 404);
  } finally { await f.close(); }
});

test('chat de perfiles: identidad, memoria, aislamiento, relectura y revocación', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-profile-chat-')));
  for (const name of ['alpha', 'beta']) {
    const home = join(root, 'profiles', name);
    mkdirSync(join(home, 'memories'), { recursive: true });
    writeFileSync(join(home, 'SOUL.md'), `Soy ${name}.`);
    writeFileSync(join(home, 'memories/MEMORY.md'), `Recuerdo de ${name}.`);
  }
  const discovery = new HermesDiscovery({ root, installation: '/not-installed', python: '', source: 'test' });
  const [alpha, beta] = discovery.scan().profiles;
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(structuredClone(turn)); return 'Respuesta de prueba'; }, undefined, discovery);
  try {
    const a = await (await f.request('/api/conversations', { profileId: alpha.id })).json();
    const b = await (await f.request('/api/conversations', { profileId: beta.id })).json();
    assert.equal(a.profileId, alpha.id); assert.equal(b.profileId, beta.id);
    assert.equal((await f.request('/api/conversations', { profileId: alpha.id, tools: ['terminal'] })).status, 400);
    assert.equal((await f.request('/api/conversations', { profileId: alpha.id, profile: { files: [] } })).status, 400);
    assert.equal((await f.request(`/api/conversations/${a.id}/messages`, { message: 'hola', documentId: '../.env' })).status, 403);
    const response = await f.request(`/api/conversations/${a.id}/messages`, { message: 'hola' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).messages[0].identity.profileId, alpha.id);
    assert.equal(turns[0].profile?.name, 'alpha'); assert.ok(turns[0].profile?.files.some(file => file.content === 'Recuerdo de alpha.'));
    await f.request(`/api/conversations/${b.id}/messages`, { message: 'hola beta' });
    assert.equal(turns[1].profile?.name, 'beta'); assert.equal(turns[1].history.length, 0);
    assert.notEqual(turns[0].sessionId, turns[1].sessionId);
    assert.equal((await f.request(`/api/conversations/${a.id}/messages`, { message: 'otro usuario' }, { Cookie: `agora_user=${'c'.repeat(64)}` })).status, 404);
    writeFileSync(join(root, 'profiles/alpha/memories/MEMORY.md'), 'Memoria actualizada');
    await f.request(`/api/conversations/${a.id}/messages`, { message: 'continúa' });
    assert.equal(turns[2].history.length, 2); assert.ok(turns[2].profile?.files.some(file => file.content === 'Memoria actualizada'));
    // A profile can be consulted about a document too: the turn carries both its identity and the document.
    const withDocument = await (await f.request(`/api/conversations/${a.id}/messages`, { message: 'resume', documentId: 'welcome' })).json();
    assert.equal(turns[3].profile?.name, 'alpha'); assert.equal(turns[3].document?.id, 'welcome');
    assert.equal(withDocument.messages.at(-2).sources[0].id, 'welcome'); assert.equal(withDocument.messages.at(-2).identity.profileId, alpha.id);
    const before = turns.length;
    const soul = join(root, 'profiles/alpha/SOUL.md'); unlinkSync(soul); symlinkSync(join(root, 'profiles/beta/SOUL.md'), soul);
    assert.equal((await f.request(`/api/conversations/${a.id}/messages`, { message: 'no ejecutar' })).status, 403);
    assert.equal(turns.length, before);
    mkdirSync(join(root, 'profiles/.deleted')); writeFileSync(join(root, 'profiles/.deleted/beta'), '1');
    assert.equal((await f.request(`/api/conversations/${b.id}/messages`, { message: 'no ejecutar' })).status, 403);
    assert.equal(turns.length, before);
    const luma = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    await f.request(`/api/conversations/${luma.id}/messages`, { message: 'hola Luma' });
    assert.equal(turns.at(-1)?.profile, undefined);
  } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test('catálogo Hermes exige token local, mantiene solo lectura y no dispara inferencia', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-hermes-read-')));
  writeFileSync(join(root, 'SOUL.md'), '# Perfil ficticio\nIdentidad local.');
  writeFileSync(join(root, '.env'), 'KEY=PRIVATE_CANARY');
  let calls = 0;
  const discovery = new HermesDiscovery({ root, installation: join(root, 'absent'), python: '', source: 'test' });
  const f = await fixture(async () => { calls++; return 'test'; }, undefined, discovery);
  try {
    assert.equal((await f.request('/api/hermes/catalog', undefined, { 'X-Agora-CSRF': '' })).status, 403);
    const response = await f.request('/api/hermes/catalog');
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.profiles.length, 1);
    const path = `/api/hermes/profiles/${catalog.profiles[0].id}`;
    const detail = await (await f.request(path)).json();
    assert.ok(detail.files[0].content.includes('Identidad local'));
    assert.ok(!JSON.stringify(detail).includes('PRIVATE_CANARY'));
    assert.equal((await f.request(path, { content: 'Cambio prohibido' }, {}, 'PUT')).status, 404);
    assert.ok(readFileSync(join(root, 'SOUL.md'), 'utf8').includes('Identidad local'));
    unlinkSync(join(root, 'SOUL.md')); unlinkSync(join(root, '.env'));
    assert.equal((await f.request(path)).status, 404);
    assert.equal(calls, 0);
  } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test('PDF/DOCX: extracción, propiedad, contexto real del adaptador y eliminación', async () => {
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(turn); return 'Prueba'; });
  try {
    for (const [name, bytes, marker] of [['uno.pdf', pdfFixture(), 'FARO-842'], ['dos.docx', await docxFixture(), 'LUNA-913']] as const) {
      const response = await f.request('/api/library/imports', { name, base64: bytes.toString('base64') });
      assert.equal(response.status, 201);
      const doc = await response.json();
      assert.equal(doc.title, name); assert.ok(doc.content.includes(marker));
      const path = `/api/library/documents/${doc.id}`;
      assert.equal((await f.request(path, undefined, { Cookie: `agora_user=${'d'.repeat(64)}` })).status, 404);
      const conversation = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
      assert.equal((await f.request(`/api/conversations/${conversation.id}/messages`, { message: '¿Clave?', documentId: doc.id })).status, 200);
      assert.ok(turns.at(-1)?.document?.content.includes(marker));
      assert.equal((await f.request(path, { title: 'Otro título' }, {}, 'PATCH')).status, 200);
      assert.equal((await f.request(path, undefined, {}, 'DELETE')).status, 200);
      assert.equal((await f.request(path)).status, 404);
    }
  } finally { await f.close(); }
});

// Node fetch rewrites Host; use HTTP directly to exercise DNS-rebinding checks.
function fetchLocal(url: string, options: { method?: string; headers: Record<string, string>; body?: string }) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url, { ...options, headers: { ...options.headers,
      ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
    } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(';') : value);
        }
        resolve(new Response(data, { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject); req.end(options.body);
  });
}

test('notas de Obsidian: exigen CSRF y no aceptan IDs fuera de un vault registrado', async () => {
  const f = await fixture(async () => { throw new Error('No debe invocar inferencia'); });
  try {
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes', undefined, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes')).status, 404);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/search?q=a')).status, 400);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes/note-000000000000000000000000')).status, 404);
    // The library route never resolves notes: they are only attached when sending a message.
    assert.equal((await f.request('/api/library/documents/note-000000000000000000000000')).status, 404);
    // Revealing hidden lines needs the CSRF header like any other local read.
    assert.equal((await f.request(`/api/hermes/profiles/profile-${"0".repeat(24)}?reveal=1`, undefined, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes/note-000000000000000000000000?reveal=1', undefined, { 'X-Agora-CSRF': '' })).status, 403);
    // Writing notes: CSRF, strict body and only notes of a registered vault.
    const note = '/api/hermes/vaults/vault-x/notes/note-000000000000000000000000', edit = { content: 'x', revision: 'a'.repeat(64) };
    assert.equal((await f.request(note, edit, { 'X-Agora-CSRF': '' }, 'PUT')).status, 403);
    assert.equal((await f.request(note, { ...edit, path: '/etc/passwd' }, {}, 'PUT')).status, 400);
    assert.equal((await f.request(note, { ...edit, revision: 'corta' }, {}, 'PUT')).status, 400);
    assert.equal((await f.request(note, edit, {}, 'PUT')).status, 404);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes', { folder: '', title: 'Nueva', content: 'x' }, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request('/api/hermes/vaults/vault-x/notes', { folder: '', title: 'Nueva', content: 'x' })).status, 404);
  } finally { await f.close(); }
});

test('notas de Obsidian: una nota consultada llega al turno de Luma por ID, recortada y sin rutas', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-vault-chat-')));
  mkdirSync(join(base, 'vault/Ideas'), { recursive: true });
  writeFileSync(join(base, 'vault/Ideas/Larga.md'), `CLAVE-NOTA-731\n${'y'.repeat(40 * 1024)}`);
  writeFileSync(join(base, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: join(base, 'vault') } } }));
  let seen: Turn | undefined;
  const f = await fixture(async turn => { seen = turn; return 'ok'; }, undefined, undefined, join(base, 'obsidian.json'));
  try {
    const vaultId = obsidianVaults(join(base, 'obsidian.json')).vaults[0].id;
    const { notes } = await (await f.request(`/api/hermes/vaults/${vaultId}/notes`)).json();
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const response = await f.request(`/api/conversations/${id}/messages`, { message: '¿Qué clave aparece?', documentId: notes[0].id });
    assert.equal(response.status, 200);
    assert.equal(seen?.document?.id, notes[0].id);
    assert.equal(seen?.document?.title, 'vault · Ideas/Larga');
    assert.match(seen!.document!.content, /^CLAVE-NOTA-731/);
    assert.ok(Buffer.byteLength(seen!.document!.content) <= 24 * 1024);
    assert.doesNotMatch(JSON.stringify(seen!.document), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('adjuntos en chats de perfil: copias ajenas, notas del vault y perfil revocado', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-profile-attach-')));
  const home = join(root, 'hermes/profiles/alpha');
  mkdirSync(join(home, 'memories'), { recursive: true });
  writeFileSync(join(home, 'SOUL.md'), 'Soy alpha.');
  mkdirSync(join(root, 'vault/Ideas'), { recursive: true });
  writeFileSync(join(root, 'vault/Ideas/Plan.md'), 'CLAVE-PERFIL-404');
  writeFileSync(join(root, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: join(root, 'vault') } } }));
  const discovery = new HermesDiscovery({ root: join(root, 'hermes'), installation: '/not-installed', python: '', source: 'test' });
  const [alpha] = discovery.scan().profiles;
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(structuredClone(turn)); return 'ok'; }, undefined, discovery, join(root, 'obsidian.json'));
  const other = { Cookie: `agora_user=${'e'.repeat(64)}` };
  try {
    const body = { name: 'privado.md', base64: Buffer.from('Dato privado: RIO-88').toString('base64') };
    const imported = await (await f.request('/api/library/imports', body)).json();
    // Another browser identity cannot attach this copy, not even through a profile chat.
    const foreign = await (await f.request('/api/conversations', { profileId: alpha.id }, other)).json();
    assert.equal((await f.request(`/api/conversations/${foreign.id}/messages`, { message: 'lee', documentId: imported.id }, other)).status, 403);
    assert.equal(turns.length, 0);
    const own = await (await f.request('/api/conversations', { profileId: alpha.id })).json();
    const vaultId = obsidianVaults(join(root, 'obsidian.json')).vaults[0].id;
    const { notes } = await (await f.request(`/api/hermes/vaults/${vaultId}/notes`)).json();
    assert.equal((await f.request(`/api/conversations/${own.id}/messages`, { message: '¿Clave?', documentId: notes[0].id })).status, 200);
    assert.equal(turns[0].profile?.name, 'alpha'); assert.match(turns[0].document!.content, /^CLAVE-PERFIL-404/);
    // Editing real profile files is a CSRF-protected mutation with a closed set of file names.
    const soulPath = `/api/hermes/profiles/${alpha.id}/files/SOUL.md`;
    assert.equal((await f.request(soulPath, { content: 'x', revision: null }, { 'X-Agora-CSRF': '' }, 'PUT')).status, 403);
    assert.equal((await f.request(`/api/hermes/profiles/${alpha.id}/files/config.yaml`, { content: 'x', revision: null }, {}, 'PUT')).status, 400);
    assert.equal((await f.request(soulPath, { content: 'x', revision: null, path: '/etc/hosts' }, {}, 'PUT')).status, 400);
    assert.equal(readFileSync(join(home, 'SOUL.md'), 'utf8'), 'Soy alpha.');
    // A revoked profile gets nothing, attachment included.
    const soul = join(home, 'SOUL.md'); unlinkSync(soul); symlinkSync(join(root, 'vault/Ideas/Plan.md'), soul);
    assert.equal((await f.request(`/api/conversations/${own.id}/messages`, { message: 'otra vez', documentId: notes[0].id })).status, 403);
    assert.equal(turns.length, 1);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test('acciones de perfiles: solo responde el dueño a lo pendiente y se guardan nombres de herramientas, no datos', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-approvals-')));
  mkdirSync(join(root, 'profiles/alpha'), { recursive: true });
  writeFileSync(join(root, 'profiles/alpha/SOUL.md'), 'Soy alpha.');
  const discovery = new HermesDiscovery({ root, installation: '/not-installed', python: '', source: 'test' });
  const [alpha] = discovery.scan().profiles;
  const f = await fixture(async (_turn, progress) => {
    progress?.({ type: 'tool', state: 'start', name: 'read_file' });
    progress?.({ type: 'tool', state: 'end', name: 'read_file' });
    return 'Leído';
  }, undefined, discovery);
  try {
    const conversation = await (await f.request('/api/conversations', { profileId: alpha.id })).json();
    const sent = await (await f.request(`/api/conversations/${conversation.id}/messages`, { message: 'lee' })).json();
    assert.deepEqual(sent.messages.at(-1).tools, ['read_file']);
    const id = 'a'.repeat(32), url = `/api/conversations/${conversation.id}/approvals/${id}`;
    assert.equal((await f.request(url, { choice: 'once' }, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request(url, { choice: 'always' })).status, 400);
    assert.equal((await f.request(url, { choice: 'once' })).status, 404, 'nada pendiente');
    assert.equal((await f.request(`/api/conversations/${conversation.id}/approvals/../x`, { choice: 'once' })).status, 404);
    const luma = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    assert.equal((await f.request(`/api/conversations/${luma.id}/approvals/${id}`, { choice: 'once' })).status, 404, 'Luma no tiene herramientas');
    assert.equal((await f.request(`/api/conversations/conversation-ajena/approvals/${id}`, { choice: 'once' })).status, 404);
    assert.equal((await f.request(`/api/conversations/${conversation.id}/cancel`, {})).status, 404, 'nada en curso que detener');
    assert.equal((await f.request(`/api/conversations/${conversation.id}/cancel`, {}, { 'X-Agora-CSRF': '' })).status, 403);
  } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test('tareas y kanban por HTTP: CSRF, cuerpo estricto y solo perfiles del catálogo', async () => {
  const f = await fixture(async () => { throw new Error('No debe invocar inferencia'); });
  const profile = `profile-${'0'.repeat(24)}`;
  try {
    const job = { name: 'Resumen', schedule: 'every 2h', prompt: 'hola' };
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/jobs`, job, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/jobs`, { ...job, deliver: 'telegram' })).status, 400, 'no se elige el destino');
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/jobs/abc`, { action: 'run', prompt: 'x' })).status, 400);
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/jobs/../x`, { action: 'run' })).status, 404);
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/cards`, { title: 'x', assignee: 'otro' })).status, 400, 'no se elige a quién se asigna');
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/cards/t_1`, { action: 'delete' })).status, 400);
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/cards`, { title: 'x' }, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request(`/api/hermes/profiles/${profile}/jobs/abc`, undefined, { 'X-Agora-CSRF': '' })).status, 403);
  } finally { await f.close(); }
});

async function fixture(adapter: Adapter, libraryRoot?: string, discovery?: HermesDiscovery, obsidianRegistry: string | null = null) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agora-test-')));
  const reads = new BackgroundReads(obsidianRegistry);
  const server = createApp({ directory, adapter, libraryRoot, privateLibraryRoot: join(directory, 'library'), discovery, obsidianRegistry, reads }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Host: '127.0.0.1:4317' };
  const status = await fetchLocal(`${url}/api/status`, { headers });
  const cookie = status.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await status.json();
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}, method = body ? 'POST' : 'GET') => fetchLocal(`${url}${path}`, {
    method, headers: { ...headers, Cookie: cookie,
      Origin: 'http://127.0.0.1:4317', 'X-Agora-CSRF': csrf, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, async close() { await reads.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true }); } };
}

test('separa propietarios y conserva historial por conversación, agente y contexto', async () => {
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(structuredClone(turn)); return 'Respuesta del doble de prueba'; });
  try {
    const created = await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const path = `/api/conversations/${id}`;
    assert.equal((await f.request(path, undefined, { Cookie: `agora_user=${'b'.repeat(64)}` })).status, 404);
    assert.equal((await f.request(`${path}/messages`, { message: 'hola' })).status, 200);
    assert.equal((await f.request(`${path}/messages`, { message: 'continúa' })).status, 200);
    assert.equal(turns[0].history.length, 0); assert.equal(turns[1].history.length, 2);
    assert.equal(turns[0].sessionId, turns[1].sessionId);
    const other = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    await f.request(`/api/conversations/${other.id}/messages`, { message: 'otra' });
    assert.notEqual(turns[2].sessionId, turns[0].sessionId); assert.equal(turns[2].history.length, 0);
    assert.equal((await f.request('/api/conversations', { agent: 'byte', context: 'library-lobby' })).status, 400);
    assert.equal((await f.request('/api/conversations', { agent: 'luma', context: '../../private' })).status, 400);
  } finally { await f.close(); }
});

test('rechaza origen, host, CSRF y ampliaciones de herramientas desde el navegador', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return 'test'; });
  try {
    const body = { agent: 'luma', context: 'library-lobby' };
    assert.equal((await f.request('/api/conversations', body, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.request('/api/conversations', body, { Host: 'evil.example' })).status, 403);
    assert.equal((await f.request('/api/conversations', body, { 'X-Agora-CSRF': '' })).status, 403);
    const { id } = await (await f.request('/api/conversations', body)).json();
    assert.equal((await f.request(`/api/conversations/${id}/messages`, { message: 'x', tools: ['terminal'] })).status, 400);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('un error no persiste una respuesta ficticia ni un turno incompleto', async () => {
  const f = await fixture(async () => { throw new Error('Proveedor no disponible'); });
  try {
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    assert.equal((await f.request(`/api/conversations/${id}/messages`, { message: 'hola' })).status, 502);
    assert.deepEqual((await (await f.request(`/api/conversations/${id}`)).json()).messages, []);
  } finally { await f.close(); }
});

test('serializa turnos para evitar pérdida de historial', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 'test'; });
  try {
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const first = f.request(`/api/conversations/${id}/messages`, { message: 'uno' });
    await started;
    assert.equal((await f.request(`/api/conversations/${id}/messages`, { message: 'dos' })).status, 409);
    release(); assert.equal((await first).status, 200);
  } finally { release?.(); await f.close(); }
});

test('documentos: solo lectura por ID y contexto validado antes de invocar Hermes', async () => {
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(structuredClone(turn)); return 'Respuesta de prueba'; });
  try {
    const list = await (await f.request('/api/library/documents')).json();
    assert.deepEqual(list.permissions, ['read']);
    assert.equal(list.documents.length, 2);
    assert.ok(!JSON.stringify(list).includes('filename'));
    const document = await (await f.request('/api/library/documents/welcome')).json();
    assert.match(document.content, /FARO-274/);
    assert.equal((await f.request('/api/library/documents/unknown')).status, 404);
    assert.equal((await f.request('/api/library/documents/welcome', { content: 'reescribir' })).status, 405);
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const path = `/api/conversations/${id}/messages`;
    assert.equal((await f.request(path, { message: 'lee', documentId: '../.env' })).status, 403);
    assert.equal((await f.request(path, { message: 'lee', documentId: 'welcome', document: { content: 'falso' } })).status, 400);
    assert.equal((await f.request(path, { message: 'lee', documentId: 'welcome' }, { Cookie: `agora_user=${'c'.repeat(64)}` })).status, 404);
    assert.equal(turns.length, 0);
    const result = await f.request(path, { message: 'resume', documentId: 'welcome' });
    assert.equal(result.status, 200);
    assert.match(turns[0].document!.content, /FARO-274/);
    const messages = (await result.json()).messages;
    assert.equal(messages[0].sources[0].revision, document.revision);
    assert.equal(messages[0].content, 'resume');
    await f.request(path, { message: 'sin adjunto' });
    assert.equal(turns[1].document, undefined);
  } finally { await f.close(); }
});

test('cada turno revalida el archivo: sustituirlo por un enlace revoca su lectura', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agora-library-test-'));
  const path = join(root, 'bienvenida.txt');
  writeFileSync(path, 'versión inicial');
  let calls = 0;
  const f = await fixture(async () => { calls++; return 'test'; }, root);
  try {
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const body = { message: 'leer', documentId: 'welcome' };
    assert.equal((await f.request(`/api/conversations/${id}/messages`, body)).status, 200);
    unlinkSync(path); symlinkSync('/etc/hosts', path);
    assert.equal((await f.request(`/api/conversations/${id}/messages`, body)).status, 403);
    assert.equal(calls, 1);
  } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test('importación HTTP: propietario, CSRF, payload limitado y acceso de Luma', async () => {
  const turns: Turn[] = [];
  const f = await fixture(async turn => { turns.push(structuredClone(turn)); return 'test'; });
  const other = { Cookie: `agora_user=${'d'.repeat(64)}` };
  const body = { name: 'privado.md', base64: Buffer.from('Dato privado: LAGO-219').toString('base64') };
  try {
    assert.equal((await f.request('/api/library/imports', body, { 'X-Agora-CSRF': '' })).status, 403);
    assert.equal((await f.request('/api/library/imports', { ...body, path: '/etc/hosts' })).status, 400);
    assert.equal((await f.request('/api/library/imports', { ...body, base64: 'A'.repeat(50000) })).status, 400);
    assert.equal((await f.request('/api/library/imports', { ...body, base64: 'A'.repeat(8 * 1024 * 1024) })).status, 413);
    const imported = await f.request('/api/library/imports', body);
    assert.equal(imported.status, 201);
    const document = await imported.json();
    assert.equal((await f.request(`/api/library/documents/${document.id}`, undefined, other)).status, 404);
    const list = await (await f.request('/api/library/documents', undefined, other)).json();
    assert.equal(list.documents.length, 2);
    const otherConversation = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' }, other)).json();
    assert.equal((await f.request(`/api/conversations/${otherConversation.id}/messages`, { message: 'lee', documentId: document.id }, other)).status, 403);
    assert.equal(turns.length, 0);
    const own = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    assert.equal((await f.request(`/api/conversations/${own.id}/messages`, { message: 'lee', documentId: document.id })).status, 200);
    assert.match(turns[0].document!.content, /LAGO-219/);
  } finally { await f.close(); }
});

test('gestión de copias: propietario, CSRF, ejemplos protegidos y revocación tras borrar', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return 'respuesta de prueba'; });
  const other = { Cookie: `agora_user=${'e'.repeat(64)}` };
  try {
    const imported = await (await f.request('/api/library/imports', { name: 'prueba.md', base64: Buffer.from('Texto original').toString('base64') })).json();
    const path = `/api/library/documents/${imported.id}`;
    assert.equal((await f.request(path, { title: 'Ajeno' }, other, 'PATCH')).status, 404);
    assert.equal((await f.request(path, undefined, other, 'DELETE')).status, 404);
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await f.request(path, { title: 'Título' }, { 'X-Agora-CSRF': '' }, method)).status, 403);
      assert.equal((await f.request('/api/library/documents/welcome', { title: 'Título' }, {}, method)).status, 404);
    }
    assert.equal((await f.request(path, { title: '../escape' }, {}, 'PATCH')).status, 400);
    assert.equal((await f.request(path, { title: 'Nombre', content: 'alterado' }, {}, 'PATCH')).status, 400);
    const renamed = await (await f.request(path, { title: 'Mis notas' }, {}, 'PATCH')).json();
    assert.equal(renamed.id, imported.id); assert.equal(renamed.revision, imported.revision);
    assert.equal(renamed.content, imported.content); assert.equal(renamed.title, 'Mis notas');
    const { id } = await (await f.request('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
    const messages = `/api/conversations/${id}/messages`;
    assert.equal((await f.request(messages, { message: 'consulta', documentId: imported.id })).status, 200);
    assert.equal((await f.request(path, undefined, {}, 'DELETE')).status, 200);
    assert.equal((await f.request(path)).status, 404);
    assert.equal((await f.request(path, { title: 'Revive' }, {}, 'PATCH')).status, 404);
    assert.equal((await f.request(messages, { message: 'otra consulta', documentId: imported.id })).status, 403);
    assert.equal(calls, 1);
    const history = await (await f.request(`/api/conversations/${id}`)).json();
    assert.equal(history.messages.length, 2); assert.equal(history.messages[0].sources[0].title, 'Mis notas');
  } finally { await f.close(); }
});
