import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HermesDiscovery } from './hermes-catalog';
import { mcpFingerprint } from './mcp-tools';
import { callMcpTool, McpCallError } from './mcp-call';

// A real MCP call through Hermes with a fictitious profile and a small local echo server: no real
// profile, credentials or service is touched. Skipped where Hermes is not installed.
const installation = join(homedir(), '.hermes/hermes-agent');
const python = join(installation, 'venv/bin/python');

const echoServer = [
  'import os',
  'from mcp.server.mcpserver import MCPServer',
  'app = MCPServer("eco")',
  '',
  '@app.tool()',
  'def eco(texto: str, veces: int = 1) -> str:',
  '    "Devuelve el texto repetido."',
  '    return " ".join([texto] * veces) + "\\napi_key: CANARY_MCP_RESULT"',
  '',
  '@app.tool()',
  'def entorno() -> str:',
  '    "Dice si ve la variable que solo tiene el perfil principal."',
  '    return os.environ.get("AGORA_CANARY_ROOT", "ausente")',
  '',
  'if __name__ == "__main__":',
  '    app.run()',
  '',
].join('\n');

test('MCP a mano: llama a la herramienta del catálogo con las credenciales del perfil y no deja procesos',
  { skip: !existsSync(python) && 'Hermes no instalado', timeout: 240_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-mcp-call-')));
    const home = join(root, 'profiles/alpha'), server = join(root, 'eco_server.py');
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(join(home, 'SOUL.md'), 'Soy alpha.');
    writeFileSync(server, echoServer);
    // «untrusted»: Hermes would ask a human for any non-read tool; the user's confirmation in AgoraOne is that human.
    writeFileSync(join(home, 'config.yaml'), [
      'model:', '  default: x', 'mcp_servers:',
      '  eco:', `    command: ${python}`, `    args: ["${server}"]`, '    trust: untrusted',
      '  apagado:', `    command: ${python}`, `    args: ["${server}"]`, '    enabled: false', ''].join('\n'));
    // A credential only the main profile has: the MCP server of another profile must not see it.
    writeFileSync(join(root, ['', 'env'].join('.')), 'AGORA_CANARY_ROOT=presente\n');
    const config = { command: python, args: [server] };
    const tools = [
      { name: 'eco', description: 'Devuelve el texto repetido.', inputSchema: { type: 'object', properties: { texto: { type: 'string' }, veces: { type: 'integer' } }, required: ['texto'] } },
      { name: 'entorno', description: 'Variable del perfil principal.', inputSchema: { type: 'object', properties: {} } },
    ];
    const now = Date.now() / 1000;
    writeFileSync(join(home, 'cache/mcp_schema_cache.json'), JSON.stringify({
      eco: { fingerprint: mcpFingerprint(config), written_at: now, tools },
      apagado: { fingerprint: mcpFingerprint(config), written_at: now, tools },
    }));
    const discovery = new HermesDiscovery({ root, installation, python, source: 'test' });
    const profile = discovery.scan().profiles.find(item => item.name === 'alpha')!;
    const serverId = profile.mcp!.find(item => item.name === 'eco')!.id;
    const disabledId = profile.mcp!.find(item => item.name === 'apagado')!.id;
    const fails = (promise: Promise<unknown>, status: number) => assert.rejects(promise, error => error instanceof McpCallError && error.status === status);
    try {
      const answer = await callMcpTool(discovery, profile.id, serverId, 'eco', { texto: 'hola', veces: 2 });
      assert.match(answer.result, /hola hola/);
      assert.doesNotMatch(answer.result, /CANARY/, 'las líneas con aspecto de clave se ocultan'); assert.equal(answer.hidden, 1);
      assert.equal((await callMcpTool(discovery, profile.id, serverId, 'entorno', {})).result, 'ausente', 'sin credenciales del perfil principal');
      await fails(callMcpTool(discovery, profile.id, serverId, 'borrar_todo', {}), 404);
      await fails(callMcpTool(discovery, profile.id, 'mcp-desconocido', 'eco', {}), 404);
      await fails(callMcpTool(discovery, profile.id, serverId, 'eco', { veces: 2 }), 400);
      await fails(callMcpTool(discovery, profile.id, serverId, 'eco', { texto: 'x', ruta: '/etc' }), 400);
      await fails(callMcpTool(discovery, profile.id, disabledId, 'eco', { texto: 'x' }), 409);
      const left = execFileSync('/bin/ps', ['-axo', 'command']).toString().split('\n').filter(line => line.includes(server));
      assert.deepEqual(left, [], 'el servidor MCP se cierra al terminar');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
