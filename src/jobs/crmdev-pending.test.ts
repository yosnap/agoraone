import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PendingItem } from '../api/clients';
import { pendingChangeText, pendingText, pendingTotal } from './clients-view';
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
  const review = readFileSync(new URL('./crmdev-batch-review.tsx', import.meta.url), 'utf8');
  assert.match(review, /previewBatch\(keys/);
  assert.match(review, /confirmBatch\(shown\.token\)/);
  assert.ok(!/<select/.test(review) && !/border-l/.test(review));
  const list = readFileSync(new URL('./crmdev-pending-list.tsx', import.meta.url), 'utf8');
  assert.match(list, /!discreet && <ActionButton icon="send"/);  // in discreet mode nothing can be sent
  assert.ok(!list.includes("'crmdev_only'") || /SENDABLE = new Set<PendingKind>\(\['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed'\]\)/.test(list));
});
