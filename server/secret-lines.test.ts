import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiddenLineError, maskSecrets, restoreSecrets } from './secret-lines';

test('líneas con claves: se ocultan enteras y el resto del texto se conserva', () => {
  const raw = [
    'Vivo en Valencia.',
    'api_key: CANARY_1',
    'Contraseña = CANARY_2',
    'export TOKEN=CANARY_3',
    'Usa sk-abcdefghijklmnop para pruebas',
    'Authorization: Bearer abcdefghijklmnopqrstu',
    'hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    '-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBg', '-----END PRIVATE KEY-----',
    'Ruta /Users/ana/Documentos/Proyectos/AgoraOne/agoraone/docs/arquitectura.md',
    'Web https://example.com/guia?lang=es',
    'Workspace 3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f',
    'Hablamos del token de acceso sin dar su valor.',
  ].join('\n');
  const { text, hidden } = maskSecrets(raw);
  assert.equal(hidden.length, 9);
  assert.doesNotMatch(text, /CANARY|sk-abc|Bearer abc|9f86d08|MIIE/);
  for (const kept of ['Vivo en Valencia.', '/Users/ana/Documentos', 'https://example.com/guia', 'token de acceso sin dar', '3f2b8c1e-9d4a']) assert.ok(text.includes(kept), kept);
  assert.equal(restoreSecrets(text, hidden), raw);
});

test('líneas con claves: al editar se recuperan por su marca, se borran si se quita y se rechazan marcas inventadas', () => {
  const { text, hidden } = maskSecrets('uno\npassword: CANARY\ndos\ntoken: OTRA-123');
  assert.equal(text, 'uno\n[línea oculta 1]\ndos\n[línea oculta 2]');
  assert.equal(restoreSecrets('UNO\n[línea oculta 1]\ndos', hidden), 'UNO\npassword: CANARY\ndos');
  assert.throws(() => restoreSecrets('[línea oculta 3]', hidden), HiddenLineError);
});

test('líneas con claves: casos reales en castellano, JSON, URLs y valores en la línea siguiente', () => {
  const visible = [
    'Valores clave: honestidad y cercanía', 'Puntos clave: orden', 'max_tokens: 4096',
    'Guía https://example.com/como-configurar-el-servidor-en-2024-paso-a-paso',
    'Ver [[2024-01-15-reunion-con-el-equipo-de-producto-y-diseno]]', 'nombre_largo_de_variable_para_pruebas_2024',
    'Usamos un token para entrar.',
  ];
  const hiddenLines = [
    '"password": "CANARY"', '{"api_key": "CANARY"}', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'postgres://admin:S3cret@db.local/app', 'PWD=CANARY', '**Contraseña**: CANARY', 'Mi clave API es CANARY',
    'clave: Xk9#mQ2p', 'token: abc123def',
  ];
  for (const line of visible) assert.equal(maskSecrets(line).hidden.length, 0, line);
  for (const line of hiddenLines) assert.equal(maskSecrets(line).hidden.length, 1, line);
  assert.equal(maskSecrets('password:\nCANARY_SIGUIENTE\nnormal').text, '[línea oculta 1]\n[línea oculta 2]\nnormal');
});

test('líneas con claves: una marca literal en el original no se confunde con una clave al restaurar', () => {
  const raw = 'x\n[línea oculta 1]\npassword: a';
  const { text, hidden } = maskSecrets(raw);
  assert.equal(text, 'x\n[línea oculta 1]\n[línea oculta 2]');
  assert.equal(restoreSecrets(text, hidden), raw);
});
