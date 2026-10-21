import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesDiscovery, fileRevision } from './hermes-catalog';
import { SkillError, createProfileSkill, listProfileSkills, readProfileSkill, saveProfileSkill } from './hermes-skills';
import { maskSecrets } from './secret-lines';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-skills-')));
  const home = join(base, 'hermes/profiles/alpha');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'memory: {}\n');
  const skill = (relative: string, content: string) => {
    const path = join(home, 'skills', relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const canary = 'api_key: SKILLS_CANARY';
  const top = skill('redaccion/SKILL.md', `---\nname: redaccion\ndescription: "Tono de los textos."\n---\n\n# Redaccion\n${canary}\n`);
  const nested = skill('redaccion/correo/SKILL.md', `---\nname: correo\ndescription: "Correos cortos."\n---\n\n# Correo\n`);
  writeFileSync(join(home, 'skills', 'redaccion', 'DESCRIPTION.md'), '# Solo una categoria\n');
  writeFileSync(join(home, 'skills', 'redaccion', 'notas.md'), '# Sin frontmatter\n');
  mkdirSync(join(home, 'skills', '.hidden'), { recursive: true });
  writeFileSync(join(home, 'skills', '.hidden', 'SKILL.md'), '---\nname: oculta\ndescription: "No se muestra."\n---\n');
  mkdirSync(join(home, 'skills', 'node_modules', 'dependencia'), { recursive: true });
  writeFileSync(join(home, 'skills', 'node_modules', 'dependencia', 'SKILL.md'), '---\nname: dependencia\ndescription: "Se excluye."\n---\n');
  const outside = join(base, 'fuera');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: fuera\ndescription: "Enlazada."\n---\n');
  symlinkSync(outside, join(home, 'skills', 'enlazada'));
  const discovery = new HermesDiscovery({ root: join(base, 'hermes'), installation: '/not-installed', python: '', source: 'test' });
  const [alpha] = discovery.scan().profiles;
  return { base, home, discovery, alpha, top, nested, outside, backups: join(base, 'backups'), close: () => rmSync(base, { recursive: true, force: true }) };
}
const rejects = async (promise: Promise<unknown>, status: number) => assert.rejects(promise, error => error instanceof SkillError && error.status === status);

test('skills: el listado solo ve carpetas reales, dos niveles, y lee nombre y descripcion', async () => {
  const f = fixture();
  try {
    const { skills, truncated } = listProfileSkills(f.discovery, f.alpha.id);
    assert.equal(truncated, false);
    assert.equal(skills.length, 2);
    const [top, nested] = skills.map(item => item.name).sort();
    assert.deepEqual([top, nested], ['correo', 'redaccion']);
    const correo = skills.find(item => item.name === 'correo')!;
    assert.equal(correo.category, 'redaccion');
    assert.equal(correo.description, 'Correos cortos.');
    assert.match(correo.id, /^skill-[a-f0-9]{24}$/);
  } finally { f.close(); }
});

test('skills: leer oculta las lineas que parecen claves y revelar las muestra', async () => {
  const f = fixture();
  try {
    const { skills } = listProfileSkills(f.discovery, f.alpha.id);
    const top = skills.find(item => item.name === 'redaccion')!;
    const masked = readProfileSkill(f.discovery, f.alpha.id, top.id);
    assert.doesNotMatch(masked.content, /SKILLS_CANARY/);
    assert.match(masked.content, /\[línea oculta 1\]/);
    assert.equal(masked.hidden, 1);
    const revealed = readProfileSkill(f.discovery, f.alpha.id, top.id, true);
    assert.match(revealed.content, /SKILLS_CANARY/);
    assert.equal(masked.revision, fileRevision(readFileSync(f.top, 'utf8')));
  } finally { f.close(); }
});

test('skills: guardar conserva las lineas ocultas, exige la revision y hace copia previa', async () => {
  const f = fixture();
  try {
    const { skills } = listProfileSkills(f.discovery, f.alpha.id);
    const top = skills.find(item => item.name === 'redaccion')!;
    const before = readFileSync(f.top, 'utf8');
    const masked = maskSecrets(before).text;
    const result = await saveProfileSkill(f.discovery, f.backups, f.alpha.id, top.id, { content: masked.replace('Redaccion', 'Estilo'), revision: fileRevision(before) });
    assert.match(readFileSync(f.top, 'utf8'), /SKILLS_CANARY/);
    assert.match(readFileSync(f.top, 'utf8'), /Estilo/);
    assert.equal(result.revision, fileRevision(readFileSync(f.top, 'utf8')));
    const folder = join(f.backups, f.alpha.id, 'skills', 'redaccion');
    const [backup] = readdirSync(folder);
    assert.equal(readFileSync(join(folder, backup), 'utf8'), before);
    await rejects(saveProfileSkill(f.discovery, f.backups, f.alpha.id, top.id, { content: 'Otra', revision: '0'.repeat(24) }), 409);
    await rejects(saveProfileSkill(f.discovery, f.backups, f.alpha.id, top.id, { content: 'B\u0007ad', revision: fileRevision(readFileSync(f.top, 'utf8')) }), 400);
    await rejects(saveProfileSkill(f.discovery, f.backups, f.alpha.id, `skill-${'0'.repeat(24)}`, { content: 'x', revision: '0'.repeat(24) }), 404);
  } finally { f.close(); }
});

test('skills: crear pone el frontmatter de Hermes, no sobrescribe y rechaza nombres invalidos', async () => {
  const f = fixture();
  try {
    const result = await createProfileSkill(f.discovery, f.backups, f.alpha.id, { category: 'nuevo', name: 'tono-telegram', description: 'Respuestas breves "con comillas".', body: 'Mantén el tono cercano.' });
    const created = join(f.home, 'skills', 'nuevo', 'tono-telegram', 'SKILL.md');
    assert.ok(existsSync(created));
    const text = readFileSync(created, 'utf8');
    assert.equal(text, '---\nname: tono-telegram\ndescription: "Respuestas breves \\"con comillas\\"."\n---\n\nMantén el tono cercano.');
    assert.equal(result.id, `skill-${fileRevision(`${realpathSync(join(f.base, 'hermes'))}:skills/nuevo/tono-telegram/SKILL.md`)}`);
    await rejects(createProfileSkill(f.discovery, f.backups, f.alpha.id, { category: 'nuevo', name: 'tono-telegram', description: '', body: 'x' }), 409);
    await rejects(createProfileSkill(f.discovery, f.backups, f.alpha.id, { category: 'a/b', name: 'x', description: '', body: 'x' }), 400);
    await rejects(createProfileSkill(f.discovery, f.backups, f.alpha.id, { category: 'nuevo', name: 'tono Telegram', description: '', body: 'x' }), 400);
  } finally { f.close(); }
});

test('skills: no se escribe a traves de carpetas enlazadas ni se listan', async () => {
  const f = fixture();
  try {
    const { skills } = listProfileSkills(f.discovery, f.alpha.id);
    assert.ok(!skills.some(item => item.name === 'fuera'), 'la carpeta enlazada no se lista');
    // A fresh walk never sees the symlinked folder, so nothing resolves into it.
    await rejects(saveProfileSkill(f.discovery, f.backups, f.alpha.id, `skill-${fileRevision(`${realpathSync(join(f.base, 'hermes'))}:skills/enlazada/SKILL.md`)}`, { content: 'x', revision: '0'.repeat(24) }), 404);
  } finally { f.close(); }
});
