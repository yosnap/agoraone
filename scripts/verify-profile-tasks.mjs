import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target } from './verify-targets.mjs';

// Managing scheduled tasks and kanban cards in a profile's card without touching Hermes: the activity
// read is answered with one fictitious task and card, and every change is intercepted and recorded here.
const profile = target('profile');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], changes = [];
  page.on('pageerror', error => errors.push(error.message));
  const job = { id: 'job_prueba', name: 'Resumen de prueba', enabled: true, state: 'scheduled', schedule: 'every 2h', lastStatus: 'ok', lastRunAt: null, nextRunAt: null };
  const card = { id: 't_prueba', title: 'Tarjeta de prueba', status: 'ready' };
  await page.route('**/api/hermes/activity', async route => {
    const data = await (await route.fetch()).json();
    for (const id of Object.keys(data.profiles)) data.profiles[id] = { ...data.profiles[id], jobs: [job], board: { byStatus: [{ status: 'ready', count: 1 }], open: [card] } };
    await route.fulfill({ json: data });
  });
  await page.route(/\/api\/hermes\/profiles\/[^/]+\/(jobs|cards)(\/[^/?]+)?$/, route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { id: job.id, name: job.name, schedule: job.schedule, once: false, prompt: 'Resume las notas\n[línea oculta 1]', revision: 'a'.repeat(24), hidden: 1 } });
    changes.push({ url: new URL(request.url()).pathname.split('/').slice(-2).join('/'), body: request.postDataJSON() });
    return route.fulfill({ json: { job: job.id, card: card.id } });
  });
  await page.goto('http://127.0.0.1:5173');
  // Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
  await page.locator('.directory').getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).click({ timeout: 120_000 });
  await page.getByText('Resumen de prueba').waitFor();
  const section = page.locator('.activity-section');
  await section.getByRole('button', { name: 'Pausar' }).click();
  await section.getByRole('button', { name: 'Ejecutar ahora' }).click();
  await section.getByText(/queda marcada/).waitFor();
  // Deleting asks first.
  await section.getByRole('button', { name: 'Eliminar', exact: true }).click();
  assert.ok(!changes.some(change => change.body.action === 'remove'));
  await section.getByRole('button', { name: 'Eliminar definitivamente' }).click();
  // Editing loads the instructions with the hidden line as a marker.
  await section.getByRole('button', { name: 'Editar' }).click();
  const form = section.getByRole('form', { name: 'Guardar cambios' });
  await form.getByRole('textbox', { name: 'Qué debe hacer el perfil' }).getByText('Resume las notas').waitFor();
  assert.match(await form.getByRole('textbox', { name: 'Qué debe hacer el perfil' }).textContent(), /\[línea oculta 1\]/);
  await form.getByLabel('Cuándo').fill('every 3h');
  await form.getByRole('button', { name: 'Guardar cambios' }).click();
  await section.getByText('Tarea «Resumen de prueba» actualizada.').waitFor();
  // A new task, with the warning that it runs on its own.
  await section.getByRole('button', { name: '+ Nueva tarea programada' }).click();
  const create = section.getByRole('form', { name: 'Crear tarea' });
  await create.getByText(/sin pedirte confirmación/).waitFor();
  await create.getByLabel('Nombre').fill('Nueva'); await create.getByLabel('Cuándo').fill('30m'); await create.getByRole('textbox', { name: 'Qué debe hacer el perfil' }).fill('Haz algo');
  await create.getByRole('button', { name: 'Crear tarea' }).click();
  await section.getByText('Tarea «Nueva» creada.').waitFor();
  // Kanban: comment, block with a reason, archive after confirming, and a new card.
  await section.getByRole('button', { name: 'Comentar' }).click();
  await section.getByRole('textbox', { name: 'Comentario' }).fill('Revisado');
  await section.getByRole('button', { name: 'Añadir comentario' }).click();
  await section.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await section.getByLabel('Motivo del bloqueo (opcional)').fill('Faltan datos');
  await section.locator('form').getByRole('button', { name: 'Bloquear' }).click();
  await section.getByRole('button', { name: 'Archivar', exact: true }).click();
  await section.getByRole('button', { name: 'Archivar definitivamente' }).click();
  await section.getByRole('button', { name: '+ Nueva tarjeta para este perfil' }).click();
  await section.getByLabel('Título').fill('Preparar informe');
  await section.getByRole('button', { name: 'Crear tarjeta' }).click();
  await section.getByRole('button', { name: '+ Nueva tarjeta para este perfil' }).waitFor();
  assert.deepEqual(changes.map(change => change.body.action ?? 'create'), ['pause', 'run', 'remove', 'update', 'create', 'comment', 'block', 'archive', 'create']);
  assert.deepEqual(changes[3].body, { action: 'update', schedule: 'every 3h' }, 'solo lo que cambió');
  assert.deepEqual(changes[6].body, { action: 'block', reason: 'Faltan datos' });
  assert.deepEqual(changes[8].body, { title: 'Preparar informe' });
  assert.deepEqual(errors, []);
  // The activity poll may still be in flight: stop intercepting before the browser closes.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  console.log(`Tareas y kanban de ${profile}: pausar, ejecutar, eliminar con confirmación, editar, crear, comentar, bloquear, archivar y tarjeta nueva (interceptado, sin tocar Hermes).`);
} finally { await browser.close(); }
