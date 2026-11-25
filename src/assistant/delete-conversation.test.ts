import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteAssistantConversation } from '../api/core';
import { ApiError } from '../api/client';

test('el borrado del Asistente envía la confirmación y la revisión de la conversación elegida', async t => {
  const createdAt = '2026-11-25T09:00:00Z';
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ deleted: true }));

  assert.deepEqual(await deleteAssistantConversation(17, createdAt), { deleted: true });
  assert.equal(fetch.mock.callCount(), 1);
  const [path, request] = fetch.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(path, '/api/core/assistant/conversations/17');
  assert.equal(request.method, 'DELETE');
  assert.deepEqual(JSON.parse(request.body as string), { confirm: true, created_at: createdAt });
});

test('el cliente distingue una conversación que cambió después de abrir la lista', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'La conversación cambió.', code: 'stale_conversation' }, { status: 409 }));

  await assert.rejects(deleteAssistantConversation(17, '2026-11-25T09:00:00Z'),
    (error: unknown) => error instanceof ApiError && error.status === 409 && error.data?.code === 'stale_conversation');
});
