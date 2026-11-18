import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISHEARD, musicQuery, quickCommand } from './quick-commands.ts';
import { meetingOrder } from './meeting-commands.ts';

test('las órdenes rápidas se reconocen', () => {
  for (const said of ['Pausa', 'siguiente canción', '¡Sube el volumen!', 'pon jazz tranquilo', 'Ponme Kind of Blue en Spotify', 'reproduce Rosalía', 'abre Notas', 'Ábreme Spotify'])
    assert.ok(quickCommand(said), said);
});

test('lo demás va a Watson, también los «pon» que no son música', () => {
  for (const said of ['¿Qué tengo mañana?', 'pon una regla para el correo de Acme', 'pon un recordatorio mañana a las 9', 'resume la reunión de ayer',
    'pon en una nota todo lo que hablamos ayer sobre el presupuesto de la web', 'abre una nota nueva sobre Acme', 'abre el correo de Hostinger'])
    assert.equal(quickCommand(said), null, said);
});

test('Watson entiende «pon…» dicho con naturalidad', () => {
  for (const said of ['Watson, pon música', 'Oye Watson pon algo de Rosalía', '¿Me puedes poner jazz?', 'pon música, por favor', 'Ponme algo', '¿Podrías ponerme Despechá de Rosalía en YouTube?'])
    assert.ok(quickCommand(said), said);
  for (const said of ['Watson, pon un recordatorio para mañana', 'oye watson qué tengo hoy'])
    assert.equal(quickCommand(said), null, said);
});

test('la búsqueda sale limpia de lo que se dice', () => {
  const cases: [string, string][] = [['¿Me puedes poner jazz?', 'jazz'], ['Watson, ¿me puedes poner jazz?', 'jazz'], ['¡Pon Despechá!', 'Despechá'],
    ['¿Podrías ponerme Despechá de Rosalía en YouTube?', 'Despechá de Rosalía'], ['Oye, Watson, pon jazz', 'jazz'], ['Watson: pon algo de Rosalía', 'Rosalía'],
    ['pon música por favor en YouTube', 'música'], ['pon la canción Gracias', 'la canción Gracias']];
  for (const [said, query] of cases) assert.equal(musicQuery(said), query, said);
});

test('lo que se le pide a Watson no se toma por música', () => {
  for (const said of ['Watson, ¿me puedes poner al día?', '¿Me puedes poner un ejemplo?', '¿Puedes poner esto en una lista?', 'ponme un resumen de lo de ayer',
    'pon un temporizador de 5 minutos', 'pon un mensaje a Marta', 'Watson pon un borrador para el cliente', 'ponme en contexto', 'Watson, pon atención a esto'])
    assert.equal(quickCommand(said), null, said);
  for (const said of ['¿Me puedes poner un poco de jazz?', 'Watson: pon algo de Rosalía', '¿Me puedes poner una canción de Rosalía?'])
    assert.ok(quickCommand(said), said);
});

test('la voz entiende la orden aunque oiga mal «Watson»', () => {
  for (const said of ['Wilson, pon música.', 'Guatson: pon a Rosalía', 'Música, por favor.', 'Watson. Pon música.'])
    assert.ok(quickCommand(said), said);
  for (const said of ['Marta, ¿qué tengo mañana?', 'Hola. Resume la reunión de ayer.', 'Vale, sigue.', 'Perfecto. Continúa.', 'Bien, siguiente.',
    'Venga, baja', 'Bueno. Sube.', 'No, silencio', 'Luis, pon la mesa', 'Ok, anterior'])
    assert.equal(quickCommand(said), null, said);
  assert.equal(musicQuery('Guatson: pon a Rosalía'.replace(MISHEARD, '')), 'a Rosalía');
});

test('grabar y parar una reunión con la voz', () => {
  for (const said of ['Oye Watson, empieza a grabar la reunión', 'Graba la reunión', 'Watson, graba', '¿Empieza a grabar?', 'Para la grabación', 'Deja de grabar', 'Hemos terminado', 'Ya hemos acabado la reunión'])
    assert.ok(quickCommand(said), said);
  const plainOf = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  assert.equal(meetingOrder(plainOf('empieza a grabar la reunion')), 'start');
  assert.equal(meetingOrder(plainOf('para la grabacion')), 'stop');
  for (const said of ['resume la reunión de ayer', 'graba una nota sobre Acme', 'para la música', 'hemos terminado el presupuesto'])
    assert.equal(meetingOrder(plainOf(said)), null, said);
  assert.equal(quickCommand('resume la reunión de ayer'), null);
});
