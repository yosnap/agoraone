import { chromium } from '@playwright/test';
import { appUrl } from './verify-targets.mjs';
import assert from 'node:assert/strict';

// Editing and creating Obsidian notes in the browser without touching the real vault: the listing, the
// note and every write are answered here with a fictitious vault, so nothing is read from or written to
// the user's notes. Covers cancel, confirm and save, a conflict with «Descartar y recargar», and a new note.
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  const notes = [{ id: 'note-' + 'a'.repeat(24), title: 'Plan del huerto', folder: 'Proyectos', bytes: 40, modifiedAt: new Date().toISOString(), readable: true }];
  const content = { [notes[0].id]: '# Plan del huerto\nRegar cada mañana.' };
  let conflict = false;
  await page.route(/\/api\/hermes\/vaults\/[^/]+\/notes(\/[^/?]+)?(\?.*)?$/, route => {
    const request = route.request(), url = request.url(), method = request.method();
    const vault = decodeURIComponent(url.split('/vaults/')[1].split('/')[0]);
    if (method === 'PUT') {
      writes.push({ method, body: request.postDataJSON() });
      if (conflict) return route.fulfill({ status: 409, json: { error: 'La nota cambió (en Obsidian o en otro sitio) mientras la editabas. Vuelve a cargarla para ver la versión actual.' } });
      content[notes[0].id] = request.postDataJSON().content;
      return route.fulfill({ json: { id: notes[0].id, revision: 'b'.repeat(64) } });
    }
    if (method === 'POST') {
      const body = request.postDataJSON();
      writes.push({ method, body });
      const id = 'note-' + 'c'.repeat(24);
      notes.push({ id, title: body.title, folder: body.folder, bytes: body.content.length, modifiedAt: new Date().toISOString(), readable: true });
      content[id] = body.content;
      return route.fulfill({ status: 201, json: { id, folder: body.folder, title: body.title } });
    }
    const noteId = url.match(/\/notes\/([^/?]+)/)?.[1];
    if (noteId) return route.fulfill({ json: { ...notes.find(note => note.id === noteId), content: content[noteId], revision: 'a'.repeat(64), hidden: 0 } });
    return route.fulfill({ json: { vault: { id: vault, name: 'Vault de prueba' }, truncated: false, notes } });
  });
  await page.goto(appUrl());
  // Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
  await page.locator('.directory').getByRole('button', { name: /^Obsidian · / }).first().click({ timeout: 120_000 });
  await page.locator('.vault-shelves button').filter({ hasText: 'Proyectos' }).click();
  await page.locator('.vault-books button').filter({ hasText: 'Plan del huerto' }).click();
  const book = page.getByRole('dialog', { name: /^Libro: Plan del huerto/ });
  await book.getByText('Regar cada mañana.').waitFor();

  // Cancelling discards the draft.
  await book.getByRole('button', { name: 'Editar nota' }).click();
  await book.getByRole('textbox', { name: 'Texto de la nota (Markdown)' }).fill('borrador descartado');
  await book.getByRole('button', { name: 'Cancelar' }).click();
  // With changes, cancelling asks first; Escape never closes the book while editing.
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await book.getByRole('button', { name: 'Descartar cambios' }).click();
  assert.equal(writes.length, 0);

  // Confirm before saving; the book shows the saved version.
  await book.getByRole('button', { name: 'Editar nota' }).click();
  assert.equal(await book.getByRole('button', { name: 'Cerrar libro' }).isDisabled(), true, 'no se cierra con cambios a medias');
  const text = book.getByRole('textbox', { name: 'Texto de la nota (Markdown)' });
  await text.fill('# Plan del huerto\nRegar cada **tarde**.');
  // Live preview: the heading is shown as a heading and its «#» hidden once the cursor leaves the line.
  await text.press('ControlOrMeta+End');
  await book.locator('.cm-md-h1').waitFor();
  assert.equal(await book.locator('.cm-md-h1').first().textContent(), 'Plan del huerto');
  assert.equal(await book.locator('.cm-md-strong').count() > 0, true);
  // «[[» suggests the vault's note titles.
  await text.press('Enter'); await text.pressSequentially('Ver [[Pla');
  await page.locator('.cm-tooltip-autocomplete').getByText('Plan del huerto').waitFor();
  await page.keyboard.press('Escape');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editor-visual.png` });
  // Links split across lines, inline code with [[ ]] or == and frontmatter must not break the editor.
  await text.fill('---\ntags:\n  - a\n---\n[nota](\nhttps://x.example)\n`if [[ -f x ]]; a == b`\n- [ ] tarea\n> [!tip] Aviso\n> texto');
  await text.press('ControlOrMeta+Home');
  await book.locator('.cm-md-front').first().waitFor();
  assert.deepEqual(errors, [], 'el editor no falla con contenidos raros');
  // Back to the exact text that the save below must send.
  await text.fill('# Plan del huerto\nRegar cada tarde.');
  await book.getByRole('button', { name: 'Guardar en el vault' }).click();
  assert.equal(writes.length, 0, 'no se guarda antes de confirmar');
  await book.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await book.getByText(/Guardada en tu vault/).waitFor();
  await book.getByText('Regar cada tarde.').waitFor();
  assert.equal(writes[0].method, 'PUT'); assert.equal(writes[0].body.revision, 'a'.repeat(64));
  assert.equal(writes[0].body.content, '# Plan del huerto\nRegar cada tarde.');

  // A change made in Obsidian meanwhile is reported and can be discarded.
  conflict = true;
  await book.getByRole('button', { name: 'Editar nota' }).click();
  await book.getByRole('textbox', { name: 'Texto de la nota (Markdown)' }).fill('otra versión');
  await book.getByRole('button', { name: 'Guardar en el vault' }).click();
  await book.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await book.getByRole('button', { name: 'Recargar y conservar mi texto' }).waitFor();
  await book.getByRole('button', { name: 'Descartar mi texto' }).click();
  await book.getByRole('button', { name: 'Editar nota' }).waitFor();
  await book.getByRole('button', { name: 'Cerrar libro' }).click();

  // A new note in the current folder opens straight in the editor.
  await page.getByRole('button', { name: '+ Nueva nota en Proyectos' }).click();
  await page.getByLabel(/Título de la nota nueva/).fill('Semillas');
  await page.getByRole('button', { name: 'Crear y editar' }).click();
  await page.getByRole('dialog', { name: /^Libro: Semillas/ }).getByLabel('Texto de la nota (Markdown)').waitFor();
  const created = writes.find(write => write.method === 'POST');
  assert.deepEqual(created.body, { folder: 'Proyectos', title: 'Semillas', content: '# Semillas\n\n' });
  assert.deepEqual(errors, []);
  console.log('Editor del vault: cancelar, confirmar, guardar, conflicto y nota nueva (vault ficticio interceptado, sin tocar tus notas).');
} finally { await browser.close(); }
