import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readHermesSummary, tallyWords, topWords } from './hermes-summary';

const now = Date.parse('2026-11-13T20:00:00Z');
const seconds = (iso: string) => Date.parse(iso) / 1000;

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.agora-summary-test-')));
  const work = join(root, 'profiles', 'work');
  mkdirSync(work, { recursive: true });
  const db = new DatabaseSync(join(work, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, started_at REAL, last_activity_at REAL, cwd TEXT, git_repo_root TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)`);
  const add = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('a', 'telegram', 'CANARY_TITLE', seconds('2026-11-12T10:00:00Z'), seconds('2026-11-13T19:00:00Z'), '/Users/x/code/tienda', '/Users/x/code/tienda', 1000, 200, 0, 0, 0, 0.5, null);
  add.run('b', 'cli', 'CANARY_TITLE', seconds('2026-11-10T10:00:00Z'), null, '/Users/x/code/tienda/src', '/Users/x/code/tienda/', 300, 100, 50, 0, 0, null, 0.25);
  add.run('c', 'cli', 'CANARY_TITLE', seconds('2026-11-11T10:00:00Z'), null, '/Users/x/notas', '', 10, 5, 0, 0, 0, 0, 0);
  add.run('d', 'cli', 'CANARY_TITLE', seconds('2026-08-01T10:00:00Z'), null, '/Users/x/viejo', '/Users/x/viejo', 99999, 0, 0, 0, 0, 9, 9);
  db.exec('CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL)');
  const say = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  say.run(1, 'a', 'user', 'Revisa la tienda y la tienda nueva, por favor. Mi clave es sk-ant-api03abcdef123456 y abcdef1234', seconds('2026-11-13T10:00:00Z'));
  say.run(2, 'a', 'assistant', 'CANARY_ASSISTANT tienda tienda tienda', seconds('2026-11-13T10:01:00Z'));
  say.run(3, 'b', 'user', 'Despliega la tienda en producción', seconds('2026-11-12T10:00:00Z'));
  say.run(4, 'b', 'user', 'mensaje antiguo antiguo antiguo', seconds('2026-07-01T10:00:00Z'));
  db.close();
  return { root, profiles: [{ id: 'work', name: 'work', home: work }] };
}

test('resumen de Hermes: tokens y coste por perfil y por proyecto (solo el nombre de la carpeta)', () => {
  const { root, profiles } = fixture();
  try {
    const before = statSync(join(profiles[0].home, 'state.db')).mtimeMs;
    const summary = readHermesSummary(root, profiles, now);
    assert.deepEqual(summary.profiles.map(p => [p.profile, p.tokens, p.costUsd, p.sessions]), [['work', 1665, 0.75, 3]]);
    assert.deepEqual(summary.projects.map(p => [p.project, p.tokens, p.sessions]), [['tienda', 1650, 2], ['notas', 15, 1]], 'el repo manda sobre la carpeta y la ruta no sale');
    assert.ok(!JSON.stringify(summary).includes('/Users'), 'nunca rutas completas');
    assert.equal(statSync(join(profiles[0].home, 'state.db')).mtimeMs, before, 'solo lectura');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resumen de Hermes: palabras de los mensajes del usuario, sin claves, sin vacías ni texto de respuestas', () => {
  const { root, profiles } = fixture();
  try {
    const summary = readHermesSummary(root, profiles, now);
    const words = Object.fromEntries(summary.words.map(w => [w.word, w.count]));
    assert.equal(words.tienda, 3, 'solo los mensajes del usuario y de los últimos 30 días');
    assert.equal(words.antiguo, undefined);
    assert.equal(summary.messagesCounted, 2);
    const text = JSON.stringify(summary);
    for (const hidden of ['CANARY', 'abcdef', 'sk-ant', 'favor']) assert.ok(!text.includes(hidden), hidden);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contar palabras: letras de 4 a 20, sin palabras vacías ni cadenas con dígitos', () => {
  const counts = tallyWords(['Agentes agentes, proyecto PROYECTO de para http://x.com token9abc aaaa Ñandú']);
  assert.deepEqual(topWords(counts), [{ word: 'agentes', count: 2 }, { word: 'proyecto', count: 2 }, { word: 'ñandú', count: 1 }]);
});
