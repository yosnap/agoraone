import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundReads } from './background-reads';
import { BrainSync } from './brain-sync';

const secret = 'd'.repeat(64);
type Call = { path: string; body?: { source?: string; notes?: { ref: string; title: string; text: string; revision: string }[]; refs?: string[]; keep?: string[] }; secret?: string };

/** A stand-in for the core's internal index routes that remembers what it was sent. */
async function fakeCore() {
  const calls: Call[] = [];
  const refs: Record<string, string> = {};
  const reject = { source: '' };
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', chunk => { raw += chunk; }).on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ path: req.url!, body, secret: req.headers['x-agora-core-secret'] as string });
      res.setHeader('content-type', 'application/json');
      if (req.url!.startsWith('/internal/index/state')) return res.end(JSON.stringify({ refs }));
      if (req.url === '/internal/index/notes' && body.source === reject.source) { res.statusCode = 422; return res.end('{}'); }
      if (req.url === '/internal/index/notes') { for (const note of body.notes) refs[note.ref] = note.revision; return res.end(JSON.stringify({ indexed: body.notes.length })); }
      if (req.url === '/internal/index/sources') return res.end(JSON.stringify({ removed: 0 }));
      if (req.url === '/internal/index/remove') { for (const ref of body.refs) delete refs[ref]; return res.end(JSON.stringify({ removed: body.refs.length })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sin puerto');
  return { calls, refs, reject, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('el índice recibe solo texto enmascarado, de forma incremental, y retira lo borrado', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-brain-sync-')));
  const vault = join(base, 'vault');
  mkdirSync(join(vault, 'Proyectos'), { recursive: true });
  mkdirSync(join(vault, '.obsidian'));
  writeFileSync(join(vault, 'Proyectos', 'Agora.md'), '# Agora\n\nEl cerebro de la oficina.\napi_key = sk-prueba1234567890\nFin.');
  writeFileSync(join(vault, 'Diario.md'), 'Hoy toca la ponencia.');
  writeFileSync(join(vault, 'Enorme.md'), 'x'.repeat(300 * 1024));
  writeFileSync(join(vault, '.obsidian', 'config.md'), 'oculto');
  writeFileSync(join(base, 'fuera.md'), 'fuera del vault');
  symlinkSync(join(base, 'fuera.md'), join(vault, 'Enlace.md'));
  writeFileSync(join(base, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: vault } } }));
  const core = await fakeCore();
  const reads = new BackgroundReads(join(base, 'obsidian.json'));
  const sync = new BrainSync(reads, { url: core.url, secret }, join(base, 'obsidian.json'));
  try {
    const first = await sync.sync();
    assert.deepEqual(first, { vaults: 1, sent: 2, removed: 0, skipped: 1, failed: 0 });
    const sent = core.calls.filter(call => call.path === '/internal/index/notes').flatMap(call => call.body!.notes!);
    assert.deepEqual(sent.map(note => note.title).sort(), ['Agora', 'Diario']);
    const agora = sent.find(note => note.title === 'Agora')!;
    assert.doesNotMatch(agora.text, /sk-prueba/, 'la línea con la clave no sale del backend');
    assert.match(agora.text, /\[línea oculta 1\]/);
    assert.ok(core.calls.every(call => call.secret === secret));
    assert.ok(!JSON.stringify(core.calls).includes('fuera del vault'), 'ni enlaces simbólicos ni carpetas ocultas');

    const again = await sync.sync();
    assert.equal(again.sent, 0, 'sin cambios no se reenvía nada');

    unlinkSync(join(vault, 'Diario.md'));
    writeFileSync(join(vault, 'Proyectos', 'Agora.md'), '# Agora\n\nCambiado y más largo que antes.');
    const third = await sync.sync();
    assert.equal(third.sent, 1); assert.equal(third.removed, 1);
    assert.deepEqual(Object.keys(core.refs).length, 1);
  } finally { await reads.close(); await core.close(); rmSync(base, { recursive: true }); }
});

test('sin vaults registrados no se llama al núcleo, y si el núcleo falla la sincronización lo dice', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-brain-sync-')));
  mkdirSync(join(base, 'vault'));
  writeFileSync(join(base, 'vault', 'Nota.md'), 'hola');
  const core = await fakeCore();
  const reads = new BackgroundReads(join(base, 'obsidian.json'));
  try {
    const none = new BrainSync(reads, { url: core.url, secret }, join(base, 'no-existe.json'));
    assert.deepEqual(await none.sync(), { vaults: 0, sent: 0, removed: 0, skipped: 0, failed: 0 });
    assert.deepEqual(core.calls.map(call => call.path), ['/internal/index/sources'], 'sin vaults solo se retira lo que ya no está');
    writeFileSync(join(base, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: join(base, 'vault') } } }));
    const down = new BrainSync(reads, { url: 'http://127.0.0.1:9', secret }, join(base, 'obsidian.json'));
    await assert.rejects(down.sync(), /núcleo/);
  } finally { await reads.close(); await core.close(); rmSync(base, { recursive: true }); }
});

test('un vault que falla no deja sin indexar a los demás, y los quitados de Obsidian se retiran', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-brain-sync-')));
  for (const name of ['uno', 'dos']) { mkdirSync(join(base, name)); writeFileSync(join(base, name, 'Nota.md'), `nota de ${name}`); }
  writeFileSync(join(base, 'dos', 'password: hunter2xyz.md'), 'título con pinta de clave');
  writeFileSync(join(base, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: join(base, 'uno') }, b: { path: join(base, 'dos') } } }));
  const core = await fakeCore();
  const reads = new BackgroundReads(join(base, 'obsidian.json'));
  try {
    const sync = new BrainSync(reads, { url: core.url, secret }, join(base, 'obsidian.json'));
    const [first] = [(await sync.sync())];
    assert.equal(first.vaults, 2); assert.equal(first.failed, 0);
    const keep = core.calls.find(call => call.path === '/internal/index/sources')!.body!.keep!;
    assert.equal(keep.length, 2, 'se conservan los dos vaults registrados');
    const titles = core.calls.filter(call => call.path === '/internal/index/notes').flatMap(call => call.body!.notes!.map(note => note.title));
    assert.ok(titles.includes('[nombre oculto]') && !titles.some(title => title.includes('hunter2')), 'un título con pinta de clave no sale');

    // The core now rejects the first vault's notes; the second must still be indexed.
    core.reject.source = keep[0];
    for (const key of Object.keys(core.refs)) delete core.refs[key];
    const before = core.calls.length;
    const second = await sync.sync();
    assert.equal(second.failed, 1); assert.equal(second.vaults, 1);
    const later = core.calls.slice(before).filter(call => call.path === '/internal/index/notes' && call.body!.source !== keep[0]);
    assert.ok(later.length, 'el otro vault se indexó igualmente');
  } finally { await reads.close(); await core.close(); rmSync(base, { recursive: true }); }
});
