import { ApiError } from '../api/client';
import { controlMusic, getApps, getLibrary, getMusic, openApp, playMusic, searchYouTube, type MusicAction } from '../api/core';
import { localActive, localControl, playLocal } from '../brain/local-player';
import { askTicket, playYouTube, stopYouTube, youtubeActive, youtubeControl } from '../brain/youtube-player';
import { lastChoice, meetingRecorder, startRecording, stopRecording } from '../meetings/meeting-recorder';
import { meetingOrder } from './meeting-commands';

/** Quick commands (1.5): what Watson does at once, without a model, when the whole message is one of these.
 * Anything else goes to the model as usual. Words are matched in Spanish, with or without accents. */
const plain = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿?¡!.,:;]/g, '').replace(/\s+/g, ' ').trim();

const controls: [RegExp, MusicAction, string][] = [
  [/^(pausa|pausar|para la musica|deten la musica|silencio)$/, 'pause', 'Música en pausa.'],
  [/^(sigue|continua|reanuda|play|dale|vuelve a poner la musica)$/, 'play', 'Sigue la música.'],
  [/^(siguiente|siguiente cancion|pasa de cancion|otra cancion|salta)$/, 'next', 'Siguiente canción.'],
  [/^(anterior|cancion anterior|la anterior|vuelve atras)$/, 'previous', 'Canción anterior.'],
  [/^(sube|sube el volumen|mas alto|subele)$/, 'louder', 'Volumen más alto.'],
  [/^(baja|baja el volumen|mas bajo|bajale)$/, 'quieter', 'Volumen más bajo.'],
];
const PLAY = /^(?:pon(?:me)?|reproduce(?:me)?|quiero (?:escuchar|oir)|toca)\s+(.+?)(?:\s+en\s+(spotify|musica|apple music|youtube|mi biblioteca|la biblioteca))?$/;
// What people add when they speak: «Oye Watson, …», «¿me puedes poner…?», «… por favor».
const CALLED = /^(?:(?:oye|hey|ok|hola)\s+)?watson\s+/;  // on plain text: commas and colons are already gone
const ASKING = /^(?:me\s+)?(?:puedes|podrias|quieres|podras)\s+(?:poner(?:me)?|reproducir(?:me)?)\s+/;
const POLITE = /\s+(?:por favor|porfa)$/;
// Insisting or correcting: «No, te he dicho que pongas…», «te pido que me pongas…», «quiero que pongas…».
const INSISTING = /^(?:no\s+)?(?:(?:ya\s+)?te\s+(?:he\s+dicho|dije|digo|pido|he\s+pedido)\s+que\s+|quiero\s+que\s+)(?:me\s+)?(?:pongas|reproduzcas|toques)\s+/;
// «Pon música», «ponme algo»: no song in particular.
const ANY = /^(?:(?:un poco de|algo de)\s+)?(?:musica|algo|la musica|lo que sea|cualquier cosa|cancion|canciones)$/;
/** The request as the commands read it: without the call to Watson, the courtesy or a trailing «please». */
const asked = (said: string) => said.replace(CALLED, '').replace(INSISTING, 'pon ').replace(ASKING, 'pon ').replace(POLITE, '').trim();
// «Pon» also means other things («pon una regla…», «pon un recordatorio…»): those go to Watson.
const NOT_MUSIC = /\b(regla|recordatorio|evento|cita|alarma|nota|tarea|correo|reunion|aviso|calendario|agenda|titulo|encargo|resumen|mensaje|borrador|temporizador|ejemplo|lista|informe|modo|whatsapp|atencion)e?s?\b|\b(al dia|al corriente|en contexto|esto|eso)\b/;
// «¿Me puedes poner…?» is music only when what follows sounds like music: a song or artist, «algo de…», «música…».
const NOT_A_SONG = /^(?:un|una|unos|unas|al|a la|en|lo|la|el)\s(?!poco de|cancion|tema|disco|album|playlist)/;

export type QuickResult = { reply: string; failed: boolean; /** Asked before doing it: run when the user says «sí». */ confirm?: () => Promise<QuickResult> };
const OPEN = /^(?:abre(?:me)?|lanza|inicia|arranca)\s+(?:la app |la aplicacion |el programa )?(.{2,40})$/;
export const YES = /^(si|vale|venga|adelante|abrela|abrelo|ok|de acuerdo)$/;
export const isYes = (text: string) => YES.test(plain(text));

/** What a «pon …» asks for, from the original words (accents kept for the search): without the call to Watson,
 * the courtesy, the question marks, «un poco de» or where to play it. */
export function musicQuery(text: string): string {
  const original = text.replace(/^[\s¿¡]+/, '').replace(/^(?:(?:oye|hey|ok|hola)[\s,]+)?watson[\s,.:;]+/i, '').replace(/^[\s¿¡]+/, '')
    .replace(/^(?:no[\s,]+)?(?:(?:ya\s+)?te\s+(?:he\s+dicho|dije|digo|pido|he\s+pedido)\s+que\s+|quiero\s+que\s+)(?:me\s+)?(?:pongas|reproduzcas|toques)\s+/i, 'pon ')
    .replace(/^(?:me\s+)?(?:puedes|podr[ií]as|quieres|podr[aá]s)\s+(?:poner(?:me)?|reproducir(?:me)?)\s+/i, 'pon ')
    .replace(/[\s,]+(?:por favor|porfa)(?=\s+en\s|\s*[.!?]*$)/i, '').replace(/[?!.]+\s*$/, '');
  return original.replace(/^\s*(pon(me)?|reproduce|quiero escuchar|toca)\s+/i, '').replace(/^(?:un poco de|algo de)\s+/i, '')
    .replace(/\s+en\s+(spotify|m[uú]sica|apple music|youtube|mi biblioteca|la biblioteca)\s*[.!?]*$/i, '').trim();
}

// Dictation often mishears the call («Wilson, pon música», «Guatson: pon jazz»): a word that sounds like «Watson»
// before a comma, colon or full stop is dropped. Only that: «Vale, sigue» or «Bien, siguiente» still go to Watson.
export const MISHEARD = /^\s*[¿¡]?(?:(?:oye|hey|ok|hola)[\s,]+)?(?:w|gu|u|b)\p{L}{1,6}[oa]n\s*[,.:;]\s+/iu;
// «Música, por favor»: the same as «pon música».
const JUST_MUSIC = /^(?:musica|un poco de musica|algo de musica)$/;

/** Whether this message is a quick command; if so, does it and says what happened. */
export function quickCommand(text: string): (() => Promise<QuickResult>) | null {
  const found = command(text);
  if (found || !MISHEARD.test(text)) return found;
  return command(text.replace(MISHEARD, ''));
}

// Said without «pon»: «Música de Alejandro Sanz desde YouTube», «canciones de Rosalía en Spotify».
const MUSIC_OF = /^(?:musica|canciones|temas|algo) de\s+\S/;
const FROM = /\bdesde\s+(youtube|spotify|m[uú]sica|apple music|mi biblioteca|la biblioteca)\b/i;

function command(text: string): (() => Promise<QuickResult>) | null {
  text = text.replace(FROM, 'en $1');  // «desde YouTube» is «en YouTube»
  if (JUST_MUSIC.test(asked(plain(text)))) text = 'pon música';
  else if (MUSIC_OF.test(asked(plain(text)))) text = `pon ${text.replace(/^[\s¿¡]*(?:(?:oye|hey|ok|hola)[\s,]+)?watson[\s,.:;]+/i, '')}`;
  const said = asked(plain(text));
  const meeting = meetingOrder(said);
  if (meeting) return () => recordByVoice(meeting);
  const control = controls.find(([pattern]) => pattern.test(said));
  // «Abre una nota…», «abre el correo de…» are requests for Watson; «abre Notas» is an app.
  const opening = control ? null : OPEN.exec(said);
  if (opening && /^(un|una|unos|unas|el|la|los|las|mi|mis|tu|lo)\s/.test(opening[1])) return null;
  if (opening) return () => openByName(opening[1]);
  const courteous = ASKING.test(plain(text).replace(CALLED, ''));
  const candidate = control || NOT_MUSIC.test(said) || said.split(' ').length > 8 ? null : PLAY.exec(said);
  const play = candidate && courteous && NOT_A_SONG.test(candidate[1]) && !candidate[2] ? null : candidate;
  if (!control && !play) return null;
  return async () => {
    try {
      if (control && youtubeActive()) { youtubeControl(control[1]); return { reply: control[2], failed: false }; }
      if (control && localActive()) { localControl(control[1]); return { reply: control[2], failed: false }; }
      const now = control ? (await getMusic()).players[0] : (await getMusic().catch(() => null))?.players[0];
      if (control) {
        if (!now) return { reply: 'No hay ningún reproductor abierto (Música o Spotify).', failed: true };
        await controlMusic(now.player, control[1]);
        return { reply: control[2], failed: false };
      }
      const where = play![2];
      const query = musicQuery(text);
      // «Pon música»: what was playing goes on; with nothing open, something calm on YouTube.
      if (!where && ANY.test(play![1])) {
        const outside = now && (now.player === 'music' || now.player === 'spotify') ? now : null;
        if (outside?.state === 'playing') return { reply: `Ya suena ${outside.title ? `«${outside.title}»` : 'música'} en ${outside.name}.`, failed: false };
        if (youtubeActive() || localActive()) {
          askTicket();  // this request wins over a YouTube search still on its way
          if (youtubeActive()) youtubeControl('play'); else localControl('play');
          return { reply: 'Sigue la música.', failed: false };
        }
        if (outside) {
          const now = outside;
          await controlMusic(now.player, 'play');
          return { reply: `Sigue ${now.title ? `«${now.title}»` : 'la música'} en ${now.name}.`, failed: false };
        }
      }
      const onYouTube = async (mine = askTicket(), before = ''): Promise<QuickResult> => {
        const { videos } = await searchYouTube(ANY.test(plain(query)) ? 'música relajante para concentrarse' : query);
        const playing = (await getMusic().catch(() => null))?.players[0];
        if (!playYouTube(videos, query, mine)) return { reply: 'Lo dejo: me has pedido otra cosa mientras buscaba.', failed: false };
        if (localActive()) localControl('pause');
        if (playing?.state === 'playing' && (playing.player === 'music' || playing.player === 'spotify')) await controlMusic(playing.player, 'pause').catch(() => undefined);
        return { reply: `${before}Pongo «${videos[0].title}» en YouTube, aquí en AgoraOne.`, failed: false };
      };
      if (where === 'youtube' || (!where && ANY.test(play![1]))) return await onYouTube();
      // Unless a player is named, the user's own library first, then the player that is open, then Music, and
      // YouTube when none of them has it (Music only searches the user's own Apple Music library).
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
      // This request's place in the queue, taken now: anything asked while Music answers wins over YouTube here.
      const mine = askTicket();
      try {
        const done = await playMusic(wanted, query);
        return { reply: done.done, failed: false };
      } catch (failure) {
        // Only when the song (or the player) is not there; a permission or a player that does not answer is said.
        if (where || !(failure instanceof ApiError) || failure.data?.reason !== 'missing') throw failure;
        return await onYouTube(mine, `No está en ${wanted === 'spotify' ? 'Spotify' : 'Música'}. `);
      }
    } catch (failure) {
      return { reply: failure instanceof Error ? failure.message : 'No se pudo hacer.', failed: true };
    }
  };
}

/** «Graba la reunión» / «para la grabación»: like the rail's button, with the last choices of the form. */
async function recordByVoice(order: 'start' | 'stop'): Promise<QuickResult> {
  const now = meetingRecorder();
  if (order === 'stop') {
    if (now.phase !== 'recording') return { reply: 'No hay ninguna reunión grabándose.', failed: true };
    stopRecording();
    return { reply: 'Paro la grabación: la reunión se transcribe en este Mac y la tendrás en Reuniones.', failed: false };
  }
  if (now.phase !== 'idle') return { reply: 'Ya estoy grabando la reunión.', failed: false };
  const choice = lastChoice();
  await startRecording('', choice.confidentiality, choice.system);
  const after = meetingRecorder();
  if (after.phase !== 'recording') return { reply: after.error || 'No se pudo empezar a grabar.', failed: true };
  return { reply: `Grabando la reunión${choice.system ? ' (tu micrófono y el audio del Mac)' : ' (tu micrófono)'}. Di «para la grabación» cuando terminéis.`, failed: false };
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
