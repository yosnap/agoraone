import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { headingsOf, Markdown } from '../src/ui/markdown';
import { findNote } from '../src/ui/vault-links';

const render = (source: string, known: string[] = []) =>
  renderToStaticMarkup(createElement(Markdown, { source, resolve: target => known.includes(target) ? () => {} : null }));

test('the note reader never turns note text into markup or unsafe links', () => {
  const html = render('<script>alert(1)</script>\n[x](javascript:alert(1)) [y](https://example.org) <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example.org" target="_blank" rel="noopener noreferrer">y<\/a>/);
});

test('the note reader formats Obsidian notes: properties, headings, lists, code, wikilinks and hidden lines', () => {
  const html = render('---\ntags: proyecto\n---\n# Título\n- [x] hecho\n- **negrita** y [[Otra nota|alias]] y [[Falta]]\n```\n**literal**\n```\n[línea oculta 1]\n> [!note] Aviso\n> texto', ['Otra nota']);
  assert.match(html, /<dt>tags<\/dt><dd>proyecto<\/dd>/);
  assert.match(html, /<h2 id="h-0-título">Título<\/h2>/);
  assert.match(html, /☑/);
  assert.match(html, /Hecho: /);
  assert.match(html, /<strong>negrita<\/strong>/);
  assert.match(html, /<button type="button" class="md-wikilink">alias<\/button>/);
  assert.match(html, /class="md-wikilink missing"[^>]*>Falta/);
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.match(html, /class="md-hidden">\[línea oculta 1\]/);
  assert.match(html, /md-callout/);
  assert.deepEqual(headingsOf('---\na: b\n---\n# Uno\n```\n# no\n```\n## Dos').map(item => item.text), ['Uno', 'Dos']);
});

test('the note reader keeps every line: empty or non-YAML frontmatter, rules and fences', () => {
  const empty = render('---\n---\n# Título\ntexto importante\n\n---\npie');
  assert.match(empty, /Título/); assert.match(empty, /texto importante/); assert.match(empty, /<hr\/>/);
  const rule = render('---\nesto no es YAML\n---\nfin');
  assert.match(rule, /esto no es YAML/); assert.match(rule, /fin/);
  const lists = render('---\ntags:\n  - a\n  - b\naliases: []\n---\ncuerpo');
  assert.match(lists, /<dt>tags<\/dt><dd>a, b<\/dd>/);
  const fences = render('````\n```\n# dentro\n````\n~~~\n```\n~~~\n# Fuera');
  assert.match(fences, /# dentro/); assert.match(fences, /<h2[^>]*>Fuera<\/h2>/);
  assert.deepEqual(headingsOf('~~~\n```\n# no\n~~~\n# Sí').map(item => item.text), ['Sí']);
  assert.match(render('párrafo\n---\ndespués'), /<p>párrafo<\/p><hr\/><p>después<\/p>/);
});

test('the note reader keeps the note\'s own numbering, escaped table pipes and literal symbols', () => {
  const html = render('3. tercero\n4. cuarto\n   - viñeta\n\n| Nota | Ver |\n|---|---|\n| [[Otra nota\\|alias]] | sí |\n\n# Aprender C#\nvariable_con_guiones y snake_case_name', ['Otra nota']);
  assert.match(html, />3\.<\/span>/); assert.match(html, />4\.<\/span>/); assert.match(html, />•<\/span>/);
  assert.match(html, /<td><button type="button" class="md-wikilink">alias<\/button><\/td><td>sí<\/td>/);
  assert.match(html, /<h2[^>]*>Aprender C#<\/h2>/);
  assert.match(html, /variable_con_guiones y snake_case_name/);
  assert.match(render('[[#Sección]]'), /class="md-wikilink">#Sección/);
  assert.match(render('[w](https://es.wikipedia.org/wiki/Sol_(estrella) "t")'), /href="https:\/\/es.wikipedia.org\/wiki\/Sol_\(estrella\)"/);
});

test('the note reader stays fast on hostile lines', () => {
  for (const line of ['['.repeat(60_000), '[['.repeat(30_000), `[${'a'.repeat(60_000)}`, '*a'.repeat(30_000), '_'.repeat(60_000)]) {
    const start = performance.now();
    render(`${line}\n${line.slice(0, 9_000)}`);
    assert.ok(performance.now() - start < 500, 'una línea hostil no bloquea el lector');
  }
});

test('wikilinks resolve by title or vault path, preferring the current folder', () => {
  const note = (id: string, folder: string, title: string) => ({ id, folder, title, bytes: 1, modifiedAt: '', readable: true });
  const notes = [note('a', 'Proyectos', 'Plan'), note('b', 'Diario', 'Plan'), note('c', 'Diario/2026', 'Octubre'), note('d', 'Otro2026', 'Octubre')];
  assert.equal(findNote(notes, 'plan', 'Diario')?.id, 'b');
  assert.equal(findNote(notes, 'Plan.md')?.id, 'a');
  assert.equal(findNote(notes, '2026/Octubre')?.id, 'c');
  assert.equal(findNote(notes, 'Nada'), null);
});
