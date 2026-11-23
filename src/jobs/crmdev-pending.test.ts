import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PendingItem } from '../api/clients';
import { birthText, centralCandidates, pendingChangeText, pendingText, pendingTotal } from './clients-view';
import { openClientsFilter, takeClientsFilter, takeJobsTab } from './jobs-tab';
import { openCrmdevTab, takeCrmdevTab } from '../crmdev/use-crmdev-view';
import { openCentralTab, takeCentralTab } from '../central/use-central-view';
import { CrmdevProposals, proposedFields } from '../assistant/crmdev-proposals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withCount } from '../shell/tab-counts';
import { byOrg, projectDetail, reviewLabelOf, unplacedGroups } from '../sync/crmdev-from-central';

const item = (fields: Partial<PendingItem>): PendingItem => ({ key: 'k', kind: 'client_missing', name: 'Uno', signature: 'a'.repeat(64), dismissed: false, ...fields });

test('cada aviso de «Pendiente en CRMDev» dice qué falta o qué difiere', () => {
  assert.match(pendingText(item({ projects: 2 })), /no está en CRMDev \(2 proyectos\)/);
  assert.match(pendingText(item({ kind: 'contact_missing', contacts: 1 })), /ninguna de sus personas/);
  assert.match(pendingText(item({ kind: 'contact_missing', contacts: 0 })), /sin correo de contacto/);
  assert.match(pendingText(item({ kind: 'project_missing', client: 'Bravo', maybe: 'Blog viejo' })), /Bravo.*Quizá es «Blog viejo»/);
  assert.match(pendingText(item({ kind: 'crmdev_only', localId: 3 })), /no está en Central \(lo guardas en AgoraOne\)/);
});

test('un correo distinto solo dice que difiere; el resto enseña los dos valores', () => {
  assert.equal(pendingChangeText({ field: 'email', label: 'Correo' }), 'Correo: distinto en CRMDev');
  assert.equal(pendingChangeText({ field: 'company', label: 'Empresa', central: 'Uno SL', crmdev: 'Uno Grupo' }), 'Empresa: Uno SL en Central, Uno Grupo en CRMDev');
  assert.equal(pendingTotal({ client_missing: 1, contact_missing: 0, client_changed: 2, crmdev_only: 0, project_missing: 3, project_changed: 0 }), 6);
});

test('el Resumen abre «Desde Central» en CRMDev y «Por crear» en Central, una sola vez', () => {
  openCrmdevTab('central');
  assert.equal(takeCrmdevTab(), 'central');
  assert.equal(takeCrmdevTab(), 'proyectos');
  openCentralTab('por-crear');
  assert.equal(takeCentralTab(), 'por-crear');
  assert.equal(takeCentralTab(), 'resumen');
  openClientsFilter('unplaced');
  assert.equal(takeJobsTab(), 'clients');
  assert.equal(takeClientsFilter(), 'unplaced');
});

test('la lista y la tarjeta no usan selects nativos ni bordes de acento a la izquierda', () => {
  for (const file of ['../sync/crmdev-from-central.tsx', '../sync/central-to-create.tsx', '../sync/sync-table.tsx', '../summary/crmdev-pending-card.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/<select/.test(source) && !/border-l/.test(source), file);
  }
});

test('el envío a CRMDev se revisa antes y solo sale con «Enviar a CRMDev»', () => {
  const review = readFileSync(new URL('../sync/batch-review.tsx', import.meta.url), 'utf8');
  assert.match(review, /dest\.preview\(anyway\)/);
  assert.match(review, /dest\.confirm\(shown\.token\)/);
  assert.ok(!/<select/.test(review) && !/border-l/.test(review));
  const table = readFileSync(new URL('../sync/sync-table.tsx', import.meta.url), 'utf8');
  assert.match(table, /const can = !discreet/);  // in discreet mode nothing can be ticked nor sent
  const list = readFileSync(new URL('../sync/crmdev-from-central.tsx', import.meta.url), 'utf8');
  assert.match(list, /SENDABLE = new Set<PendingKind>\(\['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed'\]\)/);
});

test('«Crear en Central» propone sin correos ni números y solo crea tras revisar', () => {
  const births = [{ key: 'mail:' + 'a'.repeat(24), origin: 'mail' as const, name: 'Acme', hint: 'acme.es', count: 3, last: null, dismissed: false },
    { key: 'chat:7', origin: 'whatsapp' as const, name: 'Marta', hint: null, count: 1, last: null, dismissed: false }];
  assert.equal(birthText(births[0]), 'correo de acme.es · 3 veces');
  assert.equal(birthText(births[1]), 'WhatsApp');
  const base = { company: null, domains: [], projects: [], websites: [], source: 'local' as const, aliases: [], crmdevStatus: null, differences: [],
    unplaced: true, staleLink: null, contacts: [], repeated: false };
  const { local, crmdev } = centralCandidates([
    { ...base, name: 'Propio', localId: 1, centralId: null, crmdevId: null, sources: ['local'] },
    { ...base, name: 'De CRMDev', localId: null, centralId: null, crmdevId: 'r1', sources: ['crmdev'] },
    { ...base, name: 'En los dos', localId: null, centralId: 'c1', crmdevId: 'r2', sources: ['central', 'crmdev'] },
  ]);
  assert.deepEqual(local.map(c => c.name), ['Propio']);
  assert.deepEqual(crmdev.map(c => c.name), ['De CRMDev']);
  const list = readFileSync(new URL('../sync/central-to-create.tsx', import.meta.url), 'utf8');
  assert.match(list, /previewCentralBatch\(reviewing/);
  assert.match(list, /discreet=\{discreet \|\| !data\.canWrite\}/);  // without «escritura», only seen
  assert.ok(!/<select/.test(list) && !/border-l/.test(list));
});

test('«Lanzar en Orca» en tareas y tickets solo con proyecto enlazado y nunca en modo discreto', () => {
  for (const file of ['../crmdev/crmdev-tasks.tsx', '../crmdev/crmdev-tickets.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /const launchable = \(t: CrmdevT\w+\) => !discreet && t\.id && t\.projectId \? orca\.get\(t\.projectId\) : undefined/, file);
  }
  const row = readFileSync(new URL('../orca/crmdev-to-orca.tsx', import.meta.url), 'utf8');
  assert.match(row, /choices=\{\[choice\]\}/);  // only its linked project
  assert.match(row, /source=\{\{ kind, remote: id, \.\.\.\(org \? \{ org \} : \{\}\) \}\}/);  // the core reads the record, the screen never sends its text
});

test('la propuesta de Watson para CRMDev enseña lo propuesto y solo guarda con la revisión de los formularios', () => {
  assert.deepEqual(proposedFields({ kind: 'tarea', id: 't1', list: {}, changes: { status: 'DONE', title: 'Nueva' } }), [['Estado', 'DONE'], ['Título', 'Nueva']]);
  assert.deepEqual(proposedFields({ kind: 'tarea-nueva', values: { title: 'Revisar', projectId: 'p1' } }), [['Título', 'Revisar'], ['Proyecto', 'p1']]);
  const card = readFileSync(new URL('../assistant/crmdev-proposals.tsx', import.meta.url), 'utf8');
  assert.match(card, /<CrmdevReview change=\{change\}/);  // the same review and «Guardar en CRMDev» as the section's forms
  assert.ok(!/confirmCrmdevChange|<select|border-l/.test(card));
});

test('los contadores de las pestañas: «Nombre · número», «+» si CRMDev puede tener más y nada si no se sabe', () => {
  assert.equal(withCount('Proyectos', 12), 'Proyectos · 12');
  assert.equal(withCount('Tareas', 100, true), 'Tareas · 100+');
  assert.equal(withCount('Tickets', null), 'Tickets');
  assert.equal(withCount('Clientes', 0), 'Clientes · 0');
});

test('con varias organizaciones, «Desde Central» compara con la elegida y deja aparte lo que no tiene ninguna', () => {
  const items = [item({ key: 'a', org: 'o1', orgFrom: 'link' }), item({ key: 'b', org: 'o2', orgFrom: 'chosen' }), item({ key: 'c', org: null })];
  assert.deepEqual(byOrg(items, 'o1', true).mine.map(i => i.key), ['a']);
  assert.deepEqual(byOrg(items, 'o1', true).unplaced.map(i => i.key), ['c']);
  assert.deepEqual(byOrg(items, 'o2', true).mine.map(i => i.key), ['b']);
  assert.deepEqual(byOrg(items, 'o1', false).mine.map(i => i.key), ['a', 'b', 'c'], 'con una sola, todo es de ella');
  const list = readFileSync(new URL('../sync/crmdev-from-central.tsx', import.meta.url), 'utf8');
  assert.match(list, /previewBatch\(reviewing\.items\.map\(i => i\.key\), anyway, reviewing\.org\)/);  // the review goes to the organization chosen when it opened
  const review = readFileSync(new URL('../sync/batch-review.tsx', import.meta.url), 'utf8');
  assert.match(review, /Se enviará a la organización de \{dest\.name\}/);
});

test('la tarjeta de Watson dice a qué organización de CRMDev va el cambio', () => {
  const proposal = { kind: 'tarea' as const, id: 't1', reason: null, org: 'o2', orgName: 'Segunda',
    request: { kind: 'tarea' as const, id: 't1', list: {}, changes: { status: 'DONE' }, org: 'o2' } };
  const state = { list: [{ key: 1, proposal }], add: () => undefined, close: () => undefined, clear: () => undefined };
  const html = renderToStaticMarkup(createElement(CrmdevProposals, { state }));
  assert.match(html, /<dt>Organización<\/dt><dd>Segunda<\/dd>/);
});

test('responder un ticket obliga a decir quién la ve y Watson lo enseña igual', () => {
  assert.deepEqual(proposedFields({ kind: 'respuesta-ticket', id: 'k1', content: 'Ya está', internal: false }),
    [['Quién la ve', 'El cliente'], ['Respuesta', 'Ya está']]);
  const form = readFileSync(new URL('../crmdev/crmdev-reply-ticket.tsx', import.meta.url), 'utf8');
  assert.match(form, /useState<boolean \| null>\(null\)/);  // no default: a note or an answer to the client, picked each time
  assert.match(form, /disabled=\{!content\.trim\(\) \|\| internal === null\}/);
});

test('un proyecto cuyo cliente aún no está en CRMDev avisa de enviar antes los clientes', () => {
  const base = { key: 'project_missing:q1', kind: 'project_missing', name: 'Web', signature: 'x', dismissed: false, client: 'Uno' } as PendingItem;
  assert.match(projectDetail({ ...base, clientInCrmdev: false }) ?? '', /envía antes los clientes/);
  assert.equal(projectDetail({ ...base, clientInCrmdev: true }), null);
  assert.equal(reviewLabelOf('client_missing'), 'Enviar clientes');
  assert.equal(reviewLabelOf('project_missing'), 'Enviar proyectos');
});

test('«Sin organización» separa los clientes de los proyectos, cada uno con su envío', () => {
  const item = (key: string, kind: PendingItem['kind']) => ({ key, kind, name: key, signature: 'x', dismissed: false, org: null }) as PendingItem;
  const [clients, projects] = unplacedGroups([item('c', 'client_missing'), item('p', 'project_missing'), item('k', 'contact_missing')], 'Uno');
  assert.deepEqual(clients.items.map(i => i.key), ['c', 'k']);
  assert.deepEqual(projects.items.map(i => i.key), ['p']);
  assert.equal(reviewLabelOf(clients.id), 'Enviar clientes');
  assert.equal(reviewLabelOf(projects.id), 'Enviar proyectos');
});
