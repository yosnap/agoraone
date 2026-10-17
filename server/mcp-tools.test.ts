import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpFingerprint, readMcpTools } from './mcp-tools';

test('huella de configuración compatible con JSON Python, incluidos caracteres Unicode', () => {
  assert.equal(mcpFingerprint({ command: 'python', args: ['á', '😀'], tools: { include: ['z', 'a'] } }), 'aa460603bf3e61b9');
});

test('tools: catálogo local por perfil, caducidad, cambios de configuración y campos privados excluidos', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-tools-')));
  const config = { command: 'test-only' };
  mkdirSync(join(root, 'cache')); mkdirSync(join(root, 'other'));
  const cache = join(root, 'cache/mcp_schema_cache.json');
  const entry = { fingerprint: mcpFingerprint(config), tools: [{ name: 'find', description: 'Buscar notas\napi_key: CANARY', inputSchema: { properties: { query: { type: 'string', default: 'CANARY' } }, required: ['query'] }, hidden: 'CANARY' }], utility_tools: [{ hidden: 'CANARY' }], ttl_ms: 10, written_at: 1 };
  try {
    writeFileSync(cache, JSON.stringify({ demo: entry }));
    const result = readMcpTools(root, root, 'demo', config);
    assert.equal(result.state, 'expired'); assert.equal(result.tools[0].name, 'find');
    assert.deepEqual(result.tools[0].parameters, [{ name: 'query', type: 'string', required: true }]);
    assert.ok(!JSON.stringify(result).includes('CANARY'));
    assert.equal(readMcpTools(root, join(root, 'other'), 'demo', config).state, 'missing');
    assert.equal(readMcpTools(root, root, 'demo', { command: 'changed' }).state, 'changed');
    assert.equal(readMcpTools(root, root, 'demo', { command: 'changed' }).tools.length, 0);
    writeFileSync(cache, JSON.stringify({ demo: { ...entry, ttl_ms: null, written_at: null } }));
    assert.equal(readMcpTools(root, root, 'demo', config).state, 'cached');
    rmSync(cache); symlinkSync(join(root, 'unreadable'), cache);
    assert.equal(readMcpTools(root, root, 'demo', config).tools.length, 0);
  } finally { rmSync(root, { recursive: true }); }
});
