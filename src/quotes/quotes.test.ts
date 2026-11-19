import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, sectionModule } from '../shell/shell-state';
import { buildDraft, clientChoices, createdMessage, draftTotals, emptyDraft, emptyItem, itemFromRate, newDraftToken, parseAmount, quotesKey, type DraftFields } from '../api/quotes';

test('Presupuestos va justo antes de Central y depende de su módulo', () => {
  const ids = menu.map(item => item.id);
  assert.equal(ids.at(-1), 'central');
  assert.equal(ids.at(-2), 'quotes');
  assert.equal(menu.at(-2)?.label, 'Presupuestos');
  assert.equal(sectionModule.quotes, 'presupuestos');
});

test('importes escritos en español', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('900'), 900);
  assert.equal(parseAmount('12.5'), 12.5);
  assert.equal(parseAmount('1.500'), 1500);
  assert.equal(parseAmount(' 1 200,00 € '), 1200);
  for (const wrong of ['', '-5', '1,234', '12,345', 'abc', '1e3', '100000000', '0x10']) assert.equal(parseAmount(wrong), null, wrong);
});

const fields = (change: Partial<DraftFields> = {}): DraftFields => ({ ...emptyDraft(), client: ' Cliente Uno ', title: ' Web nueva ',
  items: [{ ...emptyItem(), description: 'Diseño', unitPrice: '900' }], ...change });

test('el borrador va tal cual a Central, sin campos vacíos', () => {
  const built = buildDraft(fields({ includes: 'Hosting\n\n  Dominio ', phases: [{ name: 'Inicio', percent: '50', dueDate: '' }] }));
  assert.ok('draft' in built);
  assert.deepEqual(built.draft, { client: 'Cliente Uno', title: 'Web nueva', items: [{ description: 'Diseño', unitPrice: 900, quantity: 1 }],
    phases: [{ name: 'Inicio', percent: 50 }], includes: ['Hosting', 'Dominio'], validDays: 30 });
});

test('lo que Central rechazaría se dice antes de enviarlo', () => {
  const problems: [Partial<DraftFields>, RegExp][] = [
    [{ client: '' }, /cliente/], [{ title: '  ' }, /título/], [{ items: [{ ...emptyItem(), description: 'x', unitPrice: 'mil' }] }, /precio/],
    [{ items: [{ ...emptyItem(), description: 'x', unitPrice: '100', priceMax: '50' }] }, /menor/], [{ vat: '120' }, /IVA/], [{ validDays: '0' }, /validez/],
    [{ phases: [{ name: 'x', percent: '', dueDate: '2026-02-31' }] }, /fecha/], [{ items: [] }, /partida/],
  ];
  for (const [change, message] of problems) {
    const built = buildDraft(fields(change));
    assert.ok('problem' in built && message.test(built.problem), JSON.stringify(change));
  }
});

test('totales como los suma Central, con rango si hay precio máximo', () => {
  const built = buildDraft(fields({ vat: '21', items: [{ ...emptyItem(), description: 'a', unitPrice: '900', priceMax: '1.800' }, { ...emptyItem(), description: 'b', quantity: '2', unitPrice: '100' }] }));
  assert.ok('draft' in built);
  assert.deepEqual(draftTotals(built.draft), { base: 1100, baseMax: 2000, total: 1331, totalMax: 2420 });
  const noVat = buildDraft(fields());
  assert.ok('draft' in noVat && draftTotals(noVat.draft).total === null, 'sin IVA escrito, lo pone Central');
});

test('una partida desde una tarifa', () => {
  assert.deepEqual(itemFromRate({ id: 'r', name: 'Web básica', unit: 'proyecto', price: 1500.5 }), { ...emptyItem(), description: 'Web básica', unit: 'proyecto', unitPrice: '1500,5' });
});

test('un cliente solo propio aparece pero no se puede usar; los de Central y los de presupuestos sí', () => {
  const choices = clientChoices([{ name: 'Solo Mío', source: 'local' }, { name: 'Cliente Uno', source: 'ambos' }, { name: 'Antiguo', source: 'local' }], ['Antiguo', 'Nuevo']);
  assert.deepEqual(choices, [{ name: 'Antiguo', usable: true }, { name: 'Cliente Uno', usable: true }, { name: 'Nuevo', usable: true }, { name: 'Solo Mío', usable: false }]);
});

test('un token distinto por formulario, con la forma que acepta el núcleo', () => {
  const a = newDraftToken(), b = newDraftToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{16,64}$/);
});

test('la clave de la lista cambia con los filtros', () => {
  assert.notEqual(quotesKey({ cliente: 'A' }), quotesKey());
  assert.equal(quotesKey({}), quotesKey());
});

test('un envío repetido dice que ya se había creado, sin anunciarlo como nuevo', () => {
  assert.match(createdMessage({ created: { number: 'P-2026-007', client: 'Cliente Uno' } }), /^Presupuesto P-2026-007 creado en Central como borrador para Cliente Uno/);
  const again = createdMessage({ created: { number: 'P-2026-007' }, repeated: true });
  assert.match(again, /ya se había creado/);
  assert.doesNotMatch(again, /creado en Central como borrador/);
  assert.match(createdMessage({ created: {}, warning: 'No se anotó.' }), /No se anotó\.$/);
});
