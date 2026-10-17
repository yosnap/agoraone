import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readActivity } from './hermes-activity';

const now = Date.parse('2026-10-17T20:00:00Z');
const seconds = (iso: string) => Date.parse(iso) / 1000;

function fixture(gatewayAt = '2026-10-17T19:59:30Z', pid = process.pid) {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.agora-activity-test-')));
  const work = join(root, 'profiles', 'work');
  mkdirSync(join(work, 'cron'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'gateway_state.json'), JSON.stringify({
    pid, gateway_state: 'running', updated_at: gatewayAt, active_agents: 2,
    platforms: {
      telegram: { state: 'connected', updated_at: gatewayAt, chat_id: 'CANARY_CHAT' },
      'work:telegram': { state: 'retrying', updated_at: gatewayAt },
      'work:discord': { state: 'connected', needs_attention: true, error_message: 'CANARY_ERROR' },
    },
  }));
  const sessions = new DatabaseSync(join(work, 'state.db'));
  sessions.exec('CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, chat_id TEXT, system_prompt TEXT, started_at REAL, last_activity_at REAL)');
  const add = sessions.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run('a', 'telegram', 'CANARY_TITLE', 'CANARY_CHAT', 'CANARY_PROMPT', seconds('2026-10-17T10:00:00Z'), seconds('2026-10-17T19:59:00Z'));
  add.run('b', 'cron', 'CANARY_TITLE', null, null, seconds('2026-10-17T08:00:00Z'), null);
  add.run('c', 'desktop', 'CANARY_TITLE', null, null, seconds('2026-09-01T08:00:00Z'), seconds('2026-09-01T09:00:00Z'));
  sessions.close();
  writeFileSync(join(work, 'cron', 'jobs.json'), JSON.stringify({ jobs: [{
    name: 'Resumen diario', enabled: true, state: 'scheduled', schedule_display: 'every day at 20:00', last_status: 'ok',
    last_run_at: '2026-10-16T20:00:00+02:00', next_run_at: '2026-10-17T20:00:00+02:00',
    prompt: 'CANARY_PROMPT', deliver: 'telegram:CANARY_CHAT', origin: { chat_id: 'CANARY_CHAT' },
  }] }));
  const kanban = new DatabaseSync(join(root, 'kanban.db'));
  kanban.exec('CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, assignee TEXT, status TEXT)');
  const task = kanban.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)');
  task.run('1', 'Preparar informe', 'CANARY_BODY', 'work', 'running');
  task.run('2', 'Informe anterior', 'CANARY_BODY', 'work', 'done');
  task.run('3', 'De otro perfil', 'CANARY_BODY', 'other', 'todo');
  kanban.close();
  const profiles = [{ id: 'p-default', name: 'default', home: root }, { id: 'p-work', name: 'work', home: work }];
  return { root, work, profiles, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('actividad real: gateway, conexiones por perfil, sesiones recientes, tareas y kanban sin contenido', () => {
  const { root, profiles, close } = fixture();
  try {
    const activity = readActivity(root, profiles, now);
    assert.equal(activity.gateway.state, 'running');
    assert.equal(activity.gateway.activeAgents, 2);
    assert.deepEqual(activity.profiles['p-default'].platforms.map(p => [p.name, p.state]), [['telegram', 'connected']]);
    assert.deepEqual(activity.profiles['p-work'].platforms.map(p => [p.name, p.state]), [['telegram', 'retrying'], ['discord', 'attention']]);
    const work = activity.profiles['p-work'];
    assert.equal(work.lastActivityAt, '2026-10-17T19:59:00.000Z');
    assert.deepEqual(work.recent.sort((a, b) => a.source.localeCompare(b.source)), [{ source: 'cron', sessions: 1 }, { source: 'telegram', sessions: 1 }]);
    assert.equal(work.jobs?.[0].name, 'Resumen diario');
    assert.equal(work.jobs?.[0].nextRunAt, '2026-10-17T18:00:00.000Z');
    assert.deepEqual(work.board?.open, [{ title: 'Preparar informe', status: 'running' }]);
    assert.equal(work.board?.byStatus.reduce((sum, item) => sum + item.count, 0), 2);
    assert.equal(activity.profiles['p-default'].jobs, null);
    assert.doesNotMatch(JSON.stringify(activity), /CANARY/);
  } finally { close(); }
});

test('actividad real: un estado antiguo o un proceso inexistente nunca se presenta como conectado', () => {
  const stale = fixture('2026-10-17T19:50:00Z');
  try {
    const activity = readActivity(stale.root, stale.profiles, now);
    assert.equal(activity.gateway.state, 'stale');
    assert.equal(activity.gateway.activeAgents, null);
    assert.ok(Object.values(activity.profiles).flatMap(p => p.platforms).every(p => p.state === 'unknown'));
  } finally { stale.close(); }
  const stopped = fixture(undefined, 2 ** 22 + 12345);
  try {
    const activity = readActivity(stopped.root, stopped.profiles, now);
    assert.equal(activity.gateway.state, 'stopped');
    assert.equal(activity.gateway.activeAgents, null);
  } finally { stopped.close(); }
});

test('actividad real: no sigue enlaces simbólicos ni falla si faltan fuentes', () => {
  const { root, work, profiles, close } = fixture();
  try {
    rmSync(join(work, 'cron', 'jobs.json'));
    const outside = mkdtempSync(join(process.cwd(), '.agora-activity-outside-'));
    writeFileSync(join(outside, 'jobs.json'), JSON.stringify([{ name: 'CANARY_OUTSIDE' }]));
    symlinkSync(join(outside, 'jobs.json'), join(work, 'cron', 'jobs.json'));
    rmSync(join(root, 'kanban.db'));
    const activity = readActivity(root, profiles, now);
    assert.equal(activity.profiles['p-work'].jobs, null);
    assert.equal(activity.profiles['p-work'].board, null);
    assert.doesNotMatch(JSON.stringify(activity), /CANARY/);
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(root, 'gateway_state.json'));
    assert.equal(readActivity(root, profiles, now).gateway.state, 'missing');
  } finally { close(); }
});
