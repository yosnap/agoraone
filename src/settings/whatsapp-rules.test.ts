import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRuleForm, chatRuleFromForm, describeChatRule, emptyChatRuleForm } from './whatsapp-rules.ts';

test('una regla de WhatsApp va del formulario al núcleo y vuelve igual', () => {
  const sent = chatRuleFromForm({ ...emptyChatRuleForm, name: ' Instinct ', contact: ' +34 600 000 002 ', action: 'important', label: 'Instinct', accountId: '3' });
  assert.deepEqual(sent, {
    name: 'Instinct', contact: '+34 600 000 002', accountId: 3, words: null, action: 'important', label: 'Instinct', scopeId: null, confidentiality: null, enabled: true,
  });
  const back = chatRuleForm({ id: 1, ...sent, confidentiality: 'private' });
  assert.equal(back.accountId, '3');
  assert.equal(back.words, '');
  assert.equal(back.confidentiality, 'private');
});

test('los campos vacíos se mandan como nada y la condición se describe', () => {
  const sent = chatRuleFromForm({ ...emptyChatRuleForm, name: 'Facturas', words: '  ' }, false);
  assert.equal(sent.words, null);
  assert.equal(sent.enabled, false);
  const text = describeChatRule({ id: 2, ...sent, contact: '+34600000002', accountId: 1, words: 'factura' }, () => 'Taller');
  assert.equal(text, 'de +34600000002 · en Taller · palabras: factura');
});
