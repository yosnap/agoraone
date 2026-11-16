import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, describe, describeWatson, outcomeLabel, uniqueKeys } from './agent-lines';

test('las acciones de Watson dicen qué hizo y solo las decisiones cómo acabaron', () => {
  const search = describeWatson({ id: 1, at: '2026-11-16T21:00:00Z', actor: 'watson', action: 'buscar', outcome: 'done' }, 'Watson');
  assert.equal(search.text, 'buscó en tus notas');
  assert.equal(search.outcome, null);
  const proposal = describeWatson({ id: 1, at: '2026-11-16T21:00:00Z', actor: 'watson', action: 'proponer_limpieza', outcome: 'done' }, 'Watson');
  assert.equal(outcomeLabel(proposal.outcome), 'Hecho');
  const sent = describeWatson({ id: 1, at: '2026-11-16T21:00:00Z', actor: 'user', action: 'mail.send', outcome: 'denied' }, 'Watson');
  assert.equal(sent.who, 'Tú');
  assert.equal(outcomeLabel(sent.outcome), 'Rechazado');
  assert.equal(describeWatson({ id: 9, at: 'x', actor: 'watson', action: 'algo_nuevo', outcome: 'done' }, 'W').text, 'algo nuevo');
});

test('lo de Hermes: tareas que fallan, conexiones caídas y claves únicas', () => {
  const job = describe({ at: '2026-11-16T21:00:00Z', kind: 'job', name: 'Resumen', status: 'error' }, 'Ana');
  assert.equal(job.outcome, 'falló');
  const session = describe({ at: '2026-11-16T21:00:00Z', kind: 'session', source: 'telegram' }, 'Ana');
  assert.equal(session.text, 'conversación por Telegram');
  assert.notEqual(job.key, session.key);
});

test('hace cuánto', () => {
  const now = Date.parse('2026-11-16T22:00:00Z');
  assert.equal(ago('2026-11-16T21:59:50Z', now), 'ahora mismo');
  assert.equal(ago('2026-11-16T21:45:00Z', now), 'hace 15 min');
  assert.equal(ago('2026-11-16T19:00:00Z', now), 'hace 3 h');
});

test('claves únicas aunque coincidan hora y tipo, y el modo discreto oculta el nombre de la tarea', () => {
  const event = { at: '2026-11-16T21:00:00Z', kind: 'session', source: 'cron' } as const;
  const keys = uniqueKeys([describe(event, 'Ana'), describe(event, 'Ana')]).map(line => line.key);
  assert.equal(new Set(keys).size, 2);
  assert.equal(describe({ at: 'x', kind: 'job', name: 'Nóminas', status: null }, 'Ana', true).text, 'una tarea programada');
});
