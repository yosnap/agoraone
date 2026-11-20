import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PendingItem } from '../api/clients';
import { birthText, centralCandidates, pendingChangeText, pendingText, pendingTotal } from './clients-view';
import { openClientsFilter, takeClientsFilter, takeJobsTab } from './jobs-tab';

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

test('el Resumen abre Clientes en «Pendiente en CRMDev»', () => {
  openClientsFilter('pending');
  assert.equal(takeJobsTab(), 'clients');
  assert.equal(takeClientsFilter(), 'pending');
});

test('la lista y la tarjeta no usan selects nativos ni bordes de acento a la izquierda', () => {
  for (const file of ['./crmdev-pending-list.tsx', '../summary/crmdev-pending-card.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/<select/.test(source) && !/border-l/.test(source), file);
  }
});

test('el envío a CRMDev se revisa antes y solo sale con «Enviar a CRMDev»', () => {
  const review = readFileSync(new URL('./batch-review.tsx', import.meta.url), 'utf8');
  assert.match(review, /dest\.preview\(anyway\)/);
  assert.match(review, /dest\.confirm\(shown\.token\)/);
  assert.ok(!/<select/.test(review) && !/border-l/.test(review));
  const list = readFileSync(new URL('./crmdev-pending-list.tsx', import.meta.url), 'utf8');
  assert.match(list, /!discreet && <ActionButton icon="send"/);  // in discreet mode nothing can be sent
  assert.ok(!list.includes("'crmdev_only'") || /SENDABLE = new Set<PendingKind>\(\['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed'\]\)/.test(list));
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
  const list = readFileSync(new URL('./central-births-list.tsx', import.meta.url), 'utf8');
  assert.match(list, /previewCentralBatch\(reviewing/);
  assert.match(list, /const can = canCentral && !discreet/);
  assert.ok(!/<select/.test(list) && !/border-l/.test(list));
});
