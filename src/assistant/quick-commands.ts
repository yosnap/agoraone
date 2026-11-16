import { controlMusic, getApps, getLibrary, getMusic, openApp, playMusic, searchYouTube, type MusicAction } from '../api/core';
import { localActive, localControl, playLocal } from '../brain/local-player';
import { askTicket, playYouTube, stopYouTube, youtubeActive, youtubeControl } from '../brain/youtube-player';

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
const PLAY = /^(?:pon(?:me)?|reproduce|quiero escuchar|toca)\s+(.+?)(?:\s+en\s+(spotify|musica|apple music|youtube|mi biblioteca|la biblioteca))?$/;
// «Pon» also means other things («pon una regla…», «pon un recordatorio…»): those go to Watson.
const NOT_MUSIC = /\b(regla|recordatorio|evento|cita|alarma|nota|tarea|correo|reunion|aviso|calendario|agenda|titulo|encargo)s?\b/;

export type QuickResult = { reply: string; failed: boolean; /** Asked before doing it: run when the user says «sí». */ confirm?: () => Promise<QuickResult> };
const OPEN = /^(?:abre(?:me)?|lanza|inicia|arranca)\s+(?:la app |la aplicacion |el programa )?(.{2,40})$/;
export const YES = /^(si|vale|venga|adelante|abrela|abrelo|ok|de acuerdo)$/;
export const isYes = (text: string) => YES.test(plain(text));

/** Whether this message is a quick command; if so, does it and says what happened. */
export function quickCommand(text: string): (() => Promise<QuickResult>) | null {
  const said = plain(text);
  const control = controls.find(([pattern]) => pattern.test(said));
  // «Abre una nota…», «abre el correo de…» are requests for Watson; «abre Notas» is an app.
  const opening = control ? null : OPEN.exec(said);
  if (opening && /^(un|una|unos|unas|el|la|los|las|mi|mis|tu|lo)\s/.test(opening[1])) return null;
  if (opening) return () => openByName(opening[1]);
  const play = control || NOT_MUSIC.test(said) || said.split(' ').length > 7 ? null : PLAY.exec(said);
  if (!control && !play) return null;
  return async () => {
    try {
      if (control && youtubeActive()) { youtubeControl(control[1]); return { reply: control[2], failed: false }; }
      if (control && localActive()) { localControl(control[1]); return { reply: control[2], failed: false }; }
      const now = (await getMusic()).players[0];
      if (control) {
        if (!now) return { reply: 'No hay ningún reproductor abierto (Música o Spotify).', failed: true };
        await controlMusic(now.player, control[1]);
        return { reply: control[2], failed: false };
      }
      const where = play![2];
      // The original words, not the accent-free ones, are what the player searches.
      const query = text.replace(/^\s*(pon(me)?|reproduce|quiero escuchar|toca)\s+/i, '').replace(/\s+en\s+(spotify|m[uú]sica|apple music|youtube|mi biblioteca|la biblioteca)\s*[.!?]*$/i, '').trim();
      if (where === 'youtube') {
        const mine = askTicket();
        const { videos } = await searchYouTube(query);
        const playing = (await getMusic().catch(() => null))?.players[0];
        if (!playYouTube(videos, query, mine)) return { reply: 'Lo dejo: me has pedido otra cosa mientras buscaba.', failed: false };
        if (localActive()) localControl('pause');
        if (playing?.state === 'playing' && (playing.player === 'music' || playing.player === 'spotify')) await controlMusic(playing.player, 'pause').catch(() => undefined);
        return { reply: `Pongo «${videos[0].title}» en YouTube, aquí en AgoraOne.`, failed: false };
      }
      // Unless a player is named, the user's own library first, then the player that is open, then Music.
      if (!where || where.includes('biblioteca')) {
        const found = await getLibrary(query).catch(() => null);
        if (found?.tracks.length) {
          if (now?.state === 'playing' && (now.player === 'music' || now.player === 'spotify')) await controlMusic(now.player, 'pause').catch(() => undefined);
          playLocal(found.tracks);
          return { reply: `Pongo «${found.tracks[0].title}»${found.tracks[0].artist ? ` de ${found.tracks[0].artist}` : ''} de tu biblioteca.`, failed: false };
        }
        if (where) return { reply: `No encuentro «${query}» en tu biblioteca.`, failed: true };
      }
      const wanted = where === 'spotify' ? 'spotify' : where ? 'music' : now && (now.player === 'spotify' || now.player === 'music') ? now.player : 'music';
      if (localActive()) localControl('pause');
      stopYouTube();
      const done = await playMusic(wanted, query);
      return { reply: done.done, failed: false };
    } catch (failure) {
      return { reply: failure instanceof Error ? failure.message : 'No se pudo hacer.', failed: true };
    }
  };
}

/** «Abre Notas»: the installed app whose name matches; the allowed ones open at once, the rest after a «sí». */
async function openByName(wanted: string): Promise<QuickResult> {
  try {
    const { apps, allowed } = await getApps();
    const names = (app: { name: string; aliases?: string[] }) => [app.name, ...(app.aliases ?? [])].map(plain);
    const target = plain(wanted);
    const app = apps.find(a => names(a).includes(target)) ?? apps.find(a => names(a).some(n => n.startsWith(target))) ?? apps.find(a => names(a).some(n => n.includes(target)));
    if (!app) return { reply: `No encuentro «${wanted}» entre las aplicaciones de este equipo.`, failed: true };
    const open = async (confirmed: boolean): Promise<QuickResult> => ({ reply: (await openApp(app.id, confirmed)).done, failed: false });
    if (allowed.includes(app.id)) return await open(false);
    return { reply: `«${app.name}» no está en tu lista de apps permitidas (Ajustes › Voz). ¿La abro? Responde «sí».`, failed: false, confirm: () => open(true).catch(failure => ({ reply: failure instanceof Error ? failure.message : 'No se pudo abrir.', failed: true })) };
  } catch (failure) {
    return { reply: failure instanceof Error ? failure.message : 'No se pudo abrir.', failed: true };
  }
}
