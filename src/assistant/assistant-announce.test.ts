import test from 'node:test';
import assert from 'node:assert/strict';
import { replyState } from './assistant-announce';

test('solo un «sí» o un «no» claros responden al aviso; lo demás es una pregunta para Watson', () => {
  for (const yes of ['sí', 'Si', 'vale', 'hecho.', 'márcala']) assert.equal(replyState(yes), 'done', yes);
  for (const no of ['no', 'descártala', 'NO!']) assert.equal(replyState(no), 'dismissed', no);
  for (const other of ['sí, pero antes dime el importe', '¿de quién es?', 'no sé', 'archívala ya']) assert.equal(replyState(other), null, other);
});
