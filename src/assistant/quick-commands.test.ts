import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickCommand } from './quick-commands.ts';

test('las órdenes rápidas se reconocen', () => {
  for (const said of ['Pausa', 'siguiente canción', '¡Sube el volumen!', 'pon jazz tranquilo', 'Ponme Kind of Blue en Spotify', 'reproduce Rosalía', 'abre Notas', 'Ábreme Spotify'])
    assert.ok(quickCommand(said), said);
});

test('lo demás va a Watson, también los «pon» que no son música', () => {
  for (const said of ['¿Qué tengo mañana?', 'pon una regla para el correo de Acme', 'pon un recordatorio mañana a las 9', 'resume la reunión de ayer',
    'pon en una nota todo lo que hablamos ayer sobre el presupuesto de la web', 'abre una nota nueva sobre Acme', 'abre el correo de Hostinger'])
    assert.equal(quickCommand(said), null, said);
});
