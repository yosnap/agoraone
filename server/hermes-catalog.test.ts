import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HermesDiscovery } from './hermes-catalog';
import { hermesLocation } from './hermes-location';
import { redact } from './hermes-safe-read';

function fixture() {
  const root = mkdtempSync(join(process.cwd(), '.agora-discovery-test-'));
  const installation = join(root, 'hermes-agent');
  mkdirSync(join(installation, 'apps/desktop/src/plugins/hermes-bots'), { recursive: true });
  writeFileSync(join(installation, 'pyproject.toml'), 'version = "0.21.4"');
  writeFileSync(join(installation, 'run_agent.py'), '');
  writeFileSync(join(installation, 'apps/desktop/src/plugins/hermes-bots/data.ts'), '// profiles.list');
  const profile = (name: string) => {
    const home = name === 'default' ? root : join(root, 'profiles', name);
    mkdirSync(join(home, 'memories'), { recursive: true });
    writeFileSync(join(home, 'SOUL.md'), '# Identidad de prueba\nAyudo con proyectos.\npasswd: CANARY_SOUL_SECRET');
    writeFileSync(join(home, 'memories/MEMORY.md'), 'Recuerdo de prueba\napi_key: CANARY_MEMORY_SECRET');
    writeFileSync(join(home, '.env'), 'KEY=CANARY_ENV_SECRET');
    return home;
  };
  profile('default');
  const discovery = new HermesDiscovery({ root, installation, python: '', source: 'test' });
  return { root, installation, discovery, profile, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('catálogo automático: perfiles vivos, SOUL/memoria, bots distintos y ausencia de secretos', () => {
  const f = fixture();
  try {
    const home = f.profile('coder');
    writeFileSync(join(home, 'profile.yaml'), 'display_name: Constructor\ndescription: Desarrollo local\nui_meta:\n  hermes-bots:\n    title: Mi bot\n    sectionName: Trabajo\n    color: "#abcdef"');
    writeFileSync(join(home, 'config.yaml'), 'api_key: CANARY_CONFIG_SECRET\nplatforms:\n  telegram:\n    enabled: true\n    token: CANARY_BOT_SECRET');
    f.profile('deleted'); mkdirSync(join(f.root, 'profiles/.deleted')); writeFileSync(join(f.root, 'profiles/.deleted/deleted'), '1');
    mkdirSync(join(f.root, 'profiles/ghost'));
    symlinkSync(home, join(f.root, 'profiles/linked'));
    const before = readFileSync(join(home, 'config.yaml'));
    const catalog = f.discovery.scan();
    assert.deepEqual(catalog.profiles.map(p => p.name), ['default', 'coder']);
    const coder = catalog.profiles[1];
    assert.equal(catalog.profiles[0].botId, null, 'Código de Desktop instalado no acredita un bot registrado');
    assert.equal(coder.label, 'Constructor'); assert.equal(coder.botLabel, 'Mi bot');
    assert.notEqual(coder.id, coder.agentId); assert.notEqual(coder.id, coder.botId);
    assert.deepEqual(coder.channels, [{ name: 'telegram', enabled: true }]);
    assert.ok(!JSON.stringify(catalog).includes('CANARY'));
    const detail = f.discovery.detail(coder.id);
    assert.ok(!JSON.stringify(detail).includes('CANARY'));
    assert.ok(detail.files.find(file => file.name === 'MEMORY.md')?.content?.includes('Recuerdo de prueba'));
    const memory = detail.files.find(file => file.name === 'MEMORY.md');
    assert.equal(memory?.hidden, 1); assert.match(memory!.content!, /\[línea oculta 1\]/);
    // Only an explicit reveal returns the hidden line.
    assert.match(f.discovery.detail(coder.id, true).files.find(file => file.name === 'MEMORY.md')!.content!, /CANARY_MEMORY_SECRET/);
    assert.deepEqual(readFileSync(join(home, 'config.yaml')), before);
    assert.throws(() => f.discovery.detail('../.env'));
    writeFileSync(join(f.root, 'profiles/.deleted/coder'), '1');
    assert.throws(() => f.discovery.detail(coder.id));
    assert.equal(f.discovery.scan(true).profiles.length, 1);
  } finally { f.close(); }
});

test('espacios: ignora carpetas históricas de sesiones y muestra proyectos declarados', () => {
  const f = fixture();
  try {
    for (const home of [f.root, f.profile('coder')]) {
      const db = new DatabaseSync(join(home, 'state.db'));
      db.exec("CREATE TABLE sessions(cwd TEXT, system_prompt TEXT); INSERT INTO sessions VALUES('/private/ficticio/proyecto', 'CANARY_PROMPT_SECRET'); INSERT INTO sessions VALUES('/tmp/od-conn-test-falso', 'CANARY_PROMPT_SECRET');");
      db.close();
    }
    const db = new DatabaseSync(join(f.root, 'profiles/coder/projects.db'));
    db.exec("CREATE TABLE projects(id TEXT, name TEXT, primary_path TEXT, archived INTEGER); INSERT INTO projects VALUES('p1','Proyecto declarado','/private/ficticio/proyecto',0); INSERT INTO projects VALUES('p2','Oculto','/private/oculto',1);"); db.close();
    const c = f.discovery.scan();
    assert.equal(c.spaces.length, 1); assert.equal(c.spaces[0].profileIds.length, 1);
    assert.equal(c.spaces[0].source, 'project'); assert.equal(c.spaces[0].label, 'Proyecto declarado');
    assert.ok(!JSON.stringify(c).includes('/private/')); assert.ok(!JSON.stringify(c).includes('CANARY'));
  } finally { f.close(); }
});

test('detección portable, formatos ausentes y enlaces rechazados sin escribir en Hermes', () => {
  assert.equal(hermesLocation({}, '/otro-usuario').root, '/otro-usuario/.hermes');
  assert.equal(hermesLocation({ HERMES_HOME: '/datos/profiles/coder' }, '/otro').root, '/datos');
  assert.equal(hermesLocation({ AGORA_HERMES_HOME: '/datos' }, '/otro').root, '/datos');
  const f = fixture();
  try {
    unlinkSync(join(f.root, 'SOUL.md')); symlinkSync(join(f.root, '.env'), join(f.root, 'SOUL.md'));
    const db = new DatabaseSync(join(f.root, 'state.db')); db.exec('CREATE TABLE unknown(id TEXT)'); db.close();
    const c = f.discovery.scan();
    assert.equal(c.state, 'partial'); assert.equal(c.profiles[0].files[0].state, 'unavailable');
    assert.ok(!JSON.stringify(c).includes('CANARY'));
    rmSync(f.root, { recursive: true });
    assert.equal(f.discovery.scan(true).state, 'missing');
    assert.equal(redact('sk-abcdef123456\npassword: foo').includes('foo'), false);
  } finally { f.close(); }
});
