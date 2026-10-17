import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mcpMetadata, obsidianVaults } from './resource-discovery';

test('MCP: solo metadatos permitidos, alcance por perfil y conexión no inferida', () => {
  const config = { mcp_servers: {
    sentry: { url: 'https://secret.test/?token=CANARY', headers: { Authorization: 'CANARY' }, env: { API_KEY: 'CANARY' }, enabled: 'off' },
    local: { command: 'private-command', args: ['CANARY'], enabled: undefined },
    zero: { enabled: 0 }, yes: { enabled: 'yes' }, invalid: 'CANARY',
  } };
  const rows = mcpMetadata('a', config);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.enabled), [false, true, false, true]);
  assert.equal(rows[0].transport, 'http'); assert.equal(rows[1].transport, 'stdio');
  assert.ok(rows.every(row => row.connection === 'unverified'));
  assert.notEqual(rows[0].id, mcpMetadata('b', config)[0].id);
  assert.ok(!/CANARY|secret.test|private-command|Authorization|API_KEY/.test(JSON.stringify(rows)));
  assert.deepEqual(mcpMetadata('a', { mcp_servers: [] }), []);
});

test('Obsidian: registro acotado, carpetas no disponibles, sin notas/rutas en la respuesta', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-obsidian-')));
  try {
    const vault = join(root, 'Vault de prueba'); mkdirSync(vault);
    writeFileSync(join(vault, 'privado.md'), 'CANARY_PRIVATE_NOTE');
    const registry = join(root, 'obsidian.json');
    writeFileSync(registry, JSON.stringify({ vaults: { a: { path: vault }, b: { path: join(root, 'disconnected') }, duplicate: { path: vault }, invalid: { path: '../relative' } }, auth: 'CANARY' }));
    const result = obsidianVaults(registry);
    assert.equal(result.vaults.length, 2);
    assert.equal(result.vaults[0].name, 'Vault de prueba'); assert.equal(result.vaults[0].available, true);
    assert.equal(result.vaults[1].available, false);
    assert.ok(!JSON.stringify(result).includes(root)); assert.ok(!JSON.stringify(result).includes('CANARY'));
    assert.deepEqual(obsidianVaults(null).vaults, []);
    const linked = join(root, 'linked.json'); symlinkSync(registry, linked);
    assert.equal(obsidianVaults(linked).vaults.length, 0);
    writeFileSync(registry, '{invalid'); assert.equal(obsidianVaults(registry).warnings.length, 1);
    writeFileSync(registry, ' '.repeat(140 * 1024)); assert.equal(obsidianVaults(registry).vaults.length, 0);
  } finally { rmSync(root, { recursive: true }); }
});
