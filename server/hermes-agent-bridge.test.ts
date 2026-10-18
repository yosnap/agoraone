import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// The real bridge against the installed Hermes, with a fictitious profile and a fake local model that
// asks for a tool: no tokens, no real profile, no user files. Skipped where Hermes is not installed.
const installation = join(homedir(), '.hermes/hermes-agent');
const python = join(installation, 'venv/bin/python');

function fakeModel(work: string, home: string) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; }).on('end', () => {
      const data = JSON.parse(body || '{}'), messages = data.messages ?? [], last = messages.at(-1) ?? {};
      const user = String([...messages].reverse().find((m: { role: string }) => m.role === 'user')?.content ?? '');
      const call = (name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const message = last.role === 'tool' ? { role: 'assistant', content: `Resultado: ${String(last.content).slice(0, 200)}` }
        : user.includes('otro perfil') ? call('read_file', { path: join(home, '.hermes/profiles/otro/auth.json') })
        : user.includes('clave privada') ? call('read_file', { path: join(home, '.ssh/id_prueba') })
        : user.includes('programa') ? call('terminal', { command: 'sleep 1', background: true })
        : user.includes('clave') ? call('write_file', { path: join(work, 'script.sh'), content: "export API_KEY='sk-proj-AbCdEf0123456789AbCdEf0123456789'\nrm -rf ~/Documentos" })
        : user.includes('escribe') ? call('write_file', { path: join(work, 'salida.txt'), content: 'hola' })
        : user.includes('lee') ? call('read_file', { path: join(work, 'nota.txt') })
        : { role: 'assistant', content: 'Hola.' };
      const finish = 'tool_calls' in message ? 'tool_calls' : 'stop';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = 'tool_calls' in message ? { role: 'assistant', tool_calls: message.tool_calls!.map((item, index) => ({ index, ...item })) } : { role: 'assistant', content: message.content };
      const chunk = (choice: object) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [choice], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;
      res.end(chunk({ index: 0, delta, finish_reason: null }) + chunk({ index: 0, delta: {}, finish_reason: finish }) + 'data: [DONE]\n\n');
    });
  });
}

test('perfil con herramientas: lee sin preguntar y solo escribe si el usuario lo permite, aunque el perfil desactive las aprobaciones',
  { skip: !existsSync(python) && 'Hermes no instalado', timeout: 180_000 }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-agent-bridge-')));
    const work = join(base, 'work'), home = join(base, 'home'), profile = join(home, '.hermes/profiles/prueba');
    mkdirSync(work); mkdirSync(join(profile, 'memories'), { recursive: true });
    writeFileSync(join(work, 'nota.txt'), 'texto de la nota');
    const model = fakeModel(work, home).listen(0, '127.0.0.1');
    await new Promise<void>(done => model.once('listening', done));
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('sin puerto');
    writeFileSync(join(profile, 'config.yaml'), `model:\n  provider: custom\n  base_url: http://127.0.0.1:${address.port}/v1\n  default: fake\n  api_key: not-a-real-key\nplatform_toolsets:\n  telegram: [file, terminal]\napprovals:\n  mode: "off"\n`);
    writeFileSync(join(profile, 'SOUL.md'), 'Soy un perfil de prueba.');
    mkdirSync(join(home, '.hermes/profiles/otro'), { recursive: true }); mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.hermes/profiles/otro/auth.json'), '{"token": "CANARY_OTHER_PROFILE"}');
    writeFileSync(join(home, '.ssh/id_prueba'), 'CANARY_PRIVATE_KEY');
    const child = spawn(python, [resolve('server/hermes_agent_bridge.py')], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, HERMES_HOME: join(home, '.hermes'), AGORA_HERMES_PATH: installation, PYTHONDONTWRITEBYTECODE: '1' } });
    child.stderr.resume();
    const events: Record<string, unknown>[] = [];
    let waiting: ((event: Record<string, unknown>) => void) | null = null;
    createInterface({ input: child.stdout }).on('line', line => {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'approval') child.stdin.write(`${JSON.stringify({ type: 'approval', requestId: event.requestId, choice: answer })}\n`);
      if (event.type === 'done') waiting?.(event);
    });
    let answer = 'deny';
    const turn = (message: string) => new Promise<Record<string, unknown>>(done => {
      events.length = 0; waiting = done;
      child.stdin.write(`${JSON.stringify({ type: 'turn', profile: 'prueba', sessionId: 'agora-00000000-0000-4000-8000-000000000001', message, history: [] })}\n`);
    });
    try {
      const read = await turn('lee la nota');
      assert.equal(read.ok, true); assert.match(String(read.reply), /texto de la nota/);
      assert.ok(!events.some(event => event.type === 'approval'), 'leer no pide permiso');

      const denied = await turn('escribe un fichero');
      assert.equal(denied.ok, true); assert.match(String(denied.reply), /BLOCKED/);
      const asked = events.find(event => event.type === 'approval');
      assert.equal(asked?.tool, 'write_file'); assert.match(String(asked?.args), /salida\.txt/);
      assert.equal(existsSync(join(work, 'salida.txt')), false, 'denegado: no se escribe');

      answer = 'once';
      const allowed = await turn('escribe un fichero');
      assert.equal(allowed.ok, true);
      assert.equal(readFileSync(join(work, 'salida.txt'), 'utf8'), 'hola');
      assert.ok(events.some(event => event.type === 'tool' && event.name === 'write_file'));
      assert.doesNotMatch(readFileSync(join(profile, 'config.yaml'), 'utf8'), /allowlist|always/, 'no se persiste ninguna aprobación');

      answer = 'deny';
      const hidden = await turn('guarda la clave');
      const card = events.find(event => event.type === 'approval');
      assert.match(String(card?.args), /rm -rf ~\/Documentos/, 'la orden se ve entera');
      assert.doesNotMatch(String(card?.args), /AbCdEf0123456789AbCdEf/, 'solo se oculta el fragmento con aspecto de clave');
      assert.equal(card?.redacted, true); assert.equal(hidden.ok, true);
      assert.equal(existsSync(join(work, 'script.sh')), false);

      // Another profile's credentials: blocked outright, without a card that could be allowed.
      const other = await turn('lee el otro perfil');
      assert.equal(other.ok, true); assert.doesNotMatch(String(other.reply), /CANARY_OTHER_PROFILE/);
      assert.ok(!events.some(event => event.type === 'approval'), 'no se puede ni permitir');
      // The user's own credentials (private keys and the like) are read only after «Permitir».
      answer = 'deny';
      const key = await turn('lee mi clave privada');
      assert.equal(events.find(event => event.type === 'approval')?.tool, 'read_file');
      assert.doesNotMatch(String(key.reply), /CANARY_PRIVATE_KEY/);

      const lasting = await turn('programa un trabajo en segundo plano');
      assert.equal(lasting.ok, true); assert.match(String(lasting.reply), /segundo plano/);
      assert.ok(!events.some(event => event.type === 'approval'), 'se bloquea sin tarjeta: no se puede permitir');
    } finally {
      child.stdin.end(); child.kill();
      model.close(); rmSync(base, { recursive: true, force: true });
    }
  });

test('perfil con herramientas: las credenciales del perfil principal no quedan en el entorno que heredan MCP y procesos de otro perfil',
  { skip: !existsSync(python) && 'Hermes no instalado', timeout: 120_000 }, () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-agent-env-')));
    mkdirSync(join(base, '.hermes'));
    // A dummy variable that only the main profile's dotenv file has.
    writeFileSync(join(base, '.hermes', ['', 'env'].join('.')), 'AGORA_CANARY_ROOT=presente\n');
    const code = [
      'import sys, os', `sys.path.insert(0, ${JSON.stringify(installation)})`, `sys.path.insert(0, ${JSON.stringify(resolve('server'))})`,
      'import hermes_agent_bridge as bridge', 'bridge.isolate_environment()',
      "print('importar', 'AGORA_CANARY_ROOT' in os.environ, file=sys.stderr)",
      'from gateway.run import _current_max_iterations', '_current_max_iterations()',
      "print('turno', 'AGORA_CANARY_ROOT' in os.environ, file=sys.stderr)",
    ].join('\n');
    try {
      const result = spawnSync(python, ['-I', '-c', code], { cwd: base, encoding: 'utf8',
        env: { HOME: base, HERMES_HOME: join(base, '.hermes'), PATH: '/usr/bin:/bin' } });
      assert.match(result.stderr, /importar False/, 'tras importar Hermes no queda en el entorno');
      assert.match(result.stderr, /turno False/, 'la recarga por turno no la vuelve a cargar');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
