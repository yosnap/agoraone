import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VaultReviewPanel } from './vault-review';

test('la revisión del vault usa un diálogo nativo con título y botón de cierre', context => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const html = renderToStaticMarkup(createElement(VaultReviewPanel, { discreet: false, onRead: () => {}, onClose: () => {} }));

  const dialog = html.match(/^<dialog\b[^>]*>/)?.[0];
  assert.ok(dialog);
  assert.match(dialog, / role="dialog"/);
  assert.match(dialog, / aria-modal="true"/);
  assert.match(dialog, / aria-labelledby="review-title"/);
  assert.match(html, /<h1 id="review-title">Revisar el vault<\/h1>/);
  assert.match(html, /<button\b[^>]*>Cerrar<\/button>/);
});
