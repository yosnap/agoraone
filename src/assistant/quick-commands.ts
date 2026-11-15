import { controlMusic, getMusic, playMusic, type MusicAction } from '../api/core';

/** Quick commands (1.5): what Watson does at once, without a model, when the whole message is one of these.
 * Anything else goes to the model as usual. Words are matched in Spanish, with or without accents. */
const plain = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿?¡!.,]/g, '').replace(/\s+/g, ' ').trim();

const controls: [RegExp, MusicAction, string][] = [
  [/^(pausa|pausar|para la musica|deten la musica|silencio)$/, 'pause', 'Música en pausa.'],
  [/^(sigue|continua|reanuda|play|dale|vuelve a poner la musica)$/, 'play', 'Sigue la música.'],
  [/^(siguiente|siguiente cancion|pasa de cancion|otra cancion|salta)$/, 'next', 'Siguiente canción.'],
  [/^(anterior|cancion anterior|la anterior|vuelve atras)$/, 'previous', 'Canción anterior.'],
  [/^(sube|sube el volumen|mas alto|subele)$/, 'louder', 'Volumen más alto.'],
  [/^(baja|baja el volumen|mas bajo|bajale)$/, 'quieter', 'Volumen más bajo.'],
];
const PLAY = /^(?:pon(?:me)?|reproduce|quiero escuchar|toca)\s+(.+?)(?:\s+en\s+(spotify|musica|apple music))?$/;
// «Pon» also means other things («pon una regla…», «pon un recordatorio…»): those go to Watson.
const NOT_MUSIC = /\b(regla|recordatorio|evento|cita|alarma|nota|tarea|correo|reunion|aviso|calendario|agenda|titulo|encargo)s?\b/;

export type QuickResult = { reply: string; failed: boolean };

/** Whether this message is a quick command; if so, does it and says what happened. */
export function quickCommand(text: string): (() => Promise<QuickResult>) | null {
  const said = plain(text);
  const control = controls.find(([pattern]) => pattern.test(said));
  const play = control || NOT_MUSIC.test(said) || said.split(' ').length > 7 ? null : PLAY.exec(said);
  if (!control && !play) return null;
  return async () => {
    try {
      const now = (await getMusic()).players[0];
      if (control) {
        if (!now) return { reply: 'No hay ningún reproductor abierto (Música o Spotify).', failed: true };
        await controlMusic(now.player, control[1]);
        return { reply: control[2], failed: false };
      }
      const wanted = play![2] === 'spotify' ? 'spotify' : play![2] ? 'music' : now && (now.player === 'spotify' || now.player === 'music') ? now.player : 'music';
      // The original words, not the accent-free ones, are what the player searches.
      const query = text.replace(/^\s*(pon(me)?|reproduce|quiero escuchar|toca)\s+/i, '').replace(/\s+en\s+(spotify|m[uú]sica|apple music)\s*[.!?]*$/i, '').trim();
      const done = await playMusic(wanted, query);
      return { reply: done.done, failed: false };
    } catch (failure) {
      return { reply: failure instanceof Error ? failure.message : 'No se pudo hacer.', failed: true };
    }
  };
}
