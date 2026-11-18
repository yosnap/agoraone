import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, sectionModule } from '../shell/shell-state';
import { openJobsTab, takeJobsTab } from '../jobs/jobs-tab';
import { CONNECTION, addDays, agendaDays, agendaRangeProblem, centralTabs, dayHeading, ensureCentral, forgetCentral, madridDay, readAtLabel, timeLabel, viewKey } from './use-central-view';

test('Central es la última entrada del menú', () => {
  assert.equal(menu.at(-1)?.id, 'central');
  assert.equal(menu.at(-1)?.label, 'Central');
  assert.equal(new Set(menu.map(item => item.id)).size, menu.length, 'sin entradas repetidas');
});

test('pestañas de Central en orden y una vista de la API por pestaña', () => {
  assert.deepEqual(centralTabs.map(t => [t.id, t.label]),
    [['resumen', 'Resumen'], ['alertas', 'Alertas'], ['pendientes', 'Pendientes'], ['clientes', 'Clientes'], ['proyectos', 'Proyectos'],
      ['webs', 'Webs'], ['servidores', 'Servidores'], ['agenda', 'Agenda de Central']]);
});

test('la clave de una vista no depende del orden de los parámetros y omite los vacíos', () => {
  assert.equal(viewKey('proyectos', { q: 'web', estado: 'ACTIVE', cliente: undefined }), viewKey('proyectos', { estado: 'ACTIVE', q: 'web' }));
  assert.notEqual(viewKey('proyectos', { estado: 'ACTIVE' }), viewKey('proyectos'));
});

test('cada vista se pide una vez y «Volver a leer» la vuelve a pedir sin tocar la conexión', async () => {
  let views = 0, connections = 0;
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  ensureCentral(CONNECTION, async () => { connections++; return {}; });
  ensureCentral('alertas?', async () => { views++; return { alerts: [] }; });
  ensureCentral('alertas?', async () => { views++; return { alerts: [] }; });
  await settle();
  assert.equal(views, 1);
  forgetCentral();
  ensureCentral(CONNECTION, async () => { connections++; return {}; });
  ensureCentral('alertas?', async () => { views++; return { alerts: [] }; });
  await settle();
  assert.equal(views, 2);
  assert.equal(connections, 1);
});

test('la copia de respaldo dice cuándo se leyó (hora de Madrid)', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  assert.equal(readAtLabel('2026-11-18T09:05:00Z', now), 'leído a las 10:05');
  assert.match(readAtLabel('2026-11-15T09:05:00Z', now), /^leído el 15 nov\.? 2026 a las 10:05$/, 'una copia de otro día dice el día');
  assert.match(readAtLabel('2026-11-17T23:30:00Z', now), /^leído a las 00:30$/, 'el día es el de Madrid');
  assert.equal(readAtLabel(null), '');
  assert.equal(readAtLabel('no es una fecha'), '');
});

test('una sección de un módulo apagado sabe de qué módulo es', () => {
  assert.equal(sectionModule.central, 'central');
  assert.equal(sectionModule.brain, undefined);
});

test('Trabajos abre la pestaña que pide otra sección una sola vez', () => {
  openJobsTab('clients');
  assert.equal(takeJobsTab(), 'clients');
  assert.equal(takeJobsTab(), 'work');
});

test('la agenda de Central va en días y horas de Madrid', () => {
  assert.equal(madridDay(new Date('2026-11-18T23:30:00Z')), '2026-11-19', 'pasada la medianoche de Madrid ya es el día siguiente');
  assert.equal(madridDay(new Date('2026-07-01T21:59:00Z')), '2026-07-01');
  assert.equal(timeLabel('2026-11-19T09:00:00.000Z'), '10:00');
  assert.equal(timeLabel(null), '');
  assert.equal(addDays('2026-11-18', 13), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.match(dayHeading('2026-11-18'), /^miércoles, 18 de noviembre de 2026$/);
});

test('la agenda de Central abarca como mucho 62 días, ambos incluidos', () => {
  assert.equal(agendaRangeProblem('2026-01-01', '2026-03-03'), null);
  assert.match(agendaRangeProblem('2026-01-01', '2026-03-04') ?? '', /62 días/);
  assert.match(agendaRangeProblem('2026-11-30', '2026-11-18') ?? '', /anterior/);
  assert.match(agendaRangeProblem('2026-02-31', '2026-03-02') ?? '', /existan/);
  assert.match(agendaRangeProblem('', '2026-03-02') ?? '', /existan/);
  assert.match(agendaRangeProblem('9999-12-01', '9999-12-31') ?? '', /existan/, 'años fuera de lo que Central acepta');
  assert.match(agendaRangeProblem('0050-01-01', '0050-01-02') ?? '', /existan/);
  assert.match(agendaRangeProblem('2026-10-01', '2026-12-01') ?? '', /62 días/, '62 días que cruzan el cambio de octubre no caben, como en Central');
  assert.equal(agendaRangeProblem('2026-10-01', '2026-11-30'), null);
  assert.equal(agendaRangeProblem('2026-03-01', '2026-05-01'), null, 'en marzo el día de 23 horas sí deja 62');
  assert.equal(agendaRangeProblem('2026-11-18', '2026-11-18'), null, 'un solo día vale');
});

test('la agenda de Central pone bajo «desde» lo que empezó antes y dice cuándo acaba lo de varios días', () => {
  const event = (start: string, end: string | null, allDay = false) => ({ summary: 'x', calendar: null, start, end, allDay, location: null, client: null, project: null });
  const days = agendaDays([
    event('2026-11-16T09:00:00.000Z', '2026-11-19T10:00:00.000Z'),
    event('2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z'),
    event('2026-11-20T00:00:00.000Z', '2026-11-22T00:00:00.000Z', true),
    event('2026-11-21T00:00:00.000Z', '2026-11-22T00:00:00.000Z', true),
  ], '2026-11-18');
  assert.deepEqual(days.map(([day, items]) => [day, items.length]), [['2026-11-18', 2], ['2026-11-20', 1], ['2026-11-21', 1]]);
  assert.match(days[0][1][0].until ?? '', /^hasta el 19 nov\.?, 11:00$/, 'empezó antes de «desde»: va bajo «desde» y dice cuándo acaba');
  assert.equal(days[0][1][1].until, null, 'acaba el mismo día');
  assert.match(days[1][1][0].until ?? '', /^hasta el 21 nov\.?$/, 'de todo el día: acaba el día antes de su fin');
  assert.equal(days[2][1][0].until, null, 'un solo día entero');
  const local = agendaDays([event('2026-11-19T23:00:00.000Z', '2026-11-21T23:00:00.000Z', true)], '2026-11-18');
  assert.match(local[0][1][0].until ?? '', /^hasta el 21 nov\.?$/, 'igual si Central corre en hora de Madrid');
  assert.equal(local[0][0], '2026-11-20');
});
