import { chromium } from '@playwright/test';
import { appUrl } from './verify-targets.mjs';
// CRMDev › Desde Central: one send per group and the warning of a project whose client is not in CRMDev. Opens one
// review (read only) and closes it: never sends.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.goto(appUrl(5173, 'crmdev'));
await page.getByRole('tab', { name: 'Desde Central' }).or(page.getByRole('button', { name: 'Desde Central' })).first().click({ timeout: 60_000 });
const groups = page.getByRole('group', { name: 'Qué ver' });
await groups.waitFor({ timeout: 60_000 }).catch(() => {});
console.log('aviso:', (await page.locator('.sync-section > p.muted').first().innerText().catch(() => '')).slice(0, 200));
const labels = await groups.getByRole('button').allInnerTexts();
console.log('grupos:', labels);
for (const label of labels) {
  await groups.getByRole('button', { name: label }).click();
  const button = await page.locator('.sync-selection button.primary, .sync-selection .button-primary, .sync-selection button').last().innerText().catch(() => '—');
  const warned = await page.locator('.sync-detail', { hasText: 'envía antes los clientes' }).count();
  console.log(`  ${label} → botón «${button.trim()}», filas con aviso de cliente: ${warned}`);
  if (shots) await page.screenshot({ path: `${shots}/crmdev-${label.split(' ·')[0].replace(/ /g, '-')}.png` });
}
const projects = labels.find(l => l.startsWith('Proyectos que faltan'));
if (projects) {
  await groups.getByRole('button', { name: projects }).click();
  const row = page.locator('tr', { has: page.locator('.sync-detail', { hasText: 'envía antes los clientes' }) }).first();
  if (await row.count()) {
    await row.locator('input[type=checkbox]').check();
    await page.locator('.sync-selection button', { hasText: 'Enviar proyectos' }).click();
    await page.locator('.notice').first().waitFor({ timeout: 30_000 }).catch(() => {});
    console.log('revisión, avisos:', await page.locator('.notice').allInnerTexts());
    if (shots) await page.screenshot({ path: `${shots}/crmdev-revision.png` });
  }
}
console.log('errores:', errors);
await browser.close();
