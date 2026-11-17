import { useSyncExternalStore } from 'react';
import { hiddenYouTube, hiddenYouTubeAvailable, openYouTube, type HiddenCommand, type Video } from '../api/core';

/** YouTube inside AgoraOne (1.7): «pon … en YouTube» plays here, in one small player for the whole app (it keeps
 * playing across sections) that is only controlled from AgoraOne: the music card, Watson and its own ✕. The player
 * is YouTube's embed (no cookies domain) driven by messages; YouTube's script never runs inside AgoraOne. A video
 * that cannot be embedded (most record labels) plays in the desktop app's hidden window with YouTube's own page; in the
 * browser, where that window does not exist, it is skipped. */
type State = { video: Video | null; playing: boolean; position: number; duration: number; volume: number; error: string; hidden: boolean; ad: boolean; starting: boolean };
const EMBED = 'https://www.youtube-nocookie.com';
let state: State = { video: null, playing: false, position: 0, duration: 0, volume: 100, error: '', hidden: false, ad: false, starting: false };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
export const useYouTube = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);

let queue: Video[] = [];
let at = 0;
let frame: HTMLIFrameElement | null = null;
let asked = '';
let heard = false;
// Each «pon …» takes a ticket: a slow YouTube search only plays if nothing was asked after it (YouTube, Spotify,
// Música or the library: they all stop YouTube, which takes a new ticket).
let ticket = 0;
export const askTicket = () => ++ticket;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const send = (func: string, args: unknown[] = []) => frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), EMBED);
// One after another, in the order given: «siguiente» twice never leaves the window on the wrong video.
let orders: Promise<unknown> = Promise.resolve();
const order = (command: HiddenCommand) => { orders = orders.then(() => hiddenYouTube(command)).catch(() => undefined); };
// Only the desktop app's own window can hear the hidden window (a browser tab would steer it blind).
const desktop = () => (window as { __agoraDesktop?: boolean }).__agoraDesktop === true;
const BLOCKED = 'Ninguno de estos vídeos deja reproducirse fuera de YouTube: las discográficas suelen bloquearlo.';
// The hidden window has this long to say the video plays before AgoraOne gives up on it.
let started = '';
let watchdog = 0;
const EMBED_WAIT = 12_000;  // ms for the embed to show any sign of life before the hidden window takes over
const EMBED_SILENT = 5000;  // a player that works answers in a second or two; error 153 never says a word
let silence = 0;
let embedAlive = false;  // the embed said it loaded the video (length, state or time): error 153 never does
// While it plays the window reports every second; silence for this long means it stopped without saying so.
let alive = 0;
const SILENT = 12000;

function go(index: number) {
  const video = queue[index];
  if (!video || (index === at && state.video?.id === video.id)) return;  // already there: nothing changes
  at = index;
  heard = false;
  embedAlive = false;
  frame = null;  // a late message of the previous video's player must not count for this one
  set({ video, playing: false, position: 0, duration: 0, error: '', ad: false, starting: !state.hidden });
  if (state.hidden) { playHidden(video); return; }
  // The embed can fail without saying so (error 153, «configuración del reproductor»: its page shows the error and
  // never sends onError). If the video shows no sign of life in a few seconds, it goes to the hidden window.
  window.clearTimeout(watchdog);
  const mine = ticket;
  // Up to 12 s for any sign that the video started; the 5 s of silence count from when the player page loaded
  // (see `pageLoaded`), so a slow network does not skip a video that works.
  watchdog = window.setTimeout(() => { if (embedStill(mine, video)) void refused(); }, EMBED_WAIT);
}

const embedStill = (mine: number, video: Video | null) => mine === ticket && !state.hidden && state.video === video && !embedAlive;
/** The player page loaded: if it says nothing at all in 5 s, its page is an error (153) and the hidden window plays it. */
function pageLoaded() {
  const mine = ticket, video = state.video;
  window.clearTimeout(silence);
  silence = window.setTimeout(() => { if (!heard && embedStill(mine, video)) void refused(); }, EMBED_SILENT);
}

function playHidden(video: Video) {
  started = '';
  order({ action: 'play', id: video.id });
  window.clearTimeout(watchdog);
  const mine = ticket;
  watchdog = window.setTimeout(() => {
    if (mine === ticket && state.hidden && state.video?.id === video.id && started !== video.id) fail('YouTube no ha empezado a reproducir el vídeo.');
  }, 30000);
}

function fail(error: string) {
  if (state.hidden) order({ action: 'stop' });
  frame = null;
  window.clearTimeout(watchdog); window.clearTimeout(alive);
  set({ video: null, playing: false, error, hidden: false, ad: false, starting: false });
}

/** The embed refused this video: the hidden window plays this same one if there is one (the desktop app); if not,
 * the next video of the queue is tried. */
async function refused() {
  const mine = ticket;
  const video = state.video;
  if (state.hidden || !video) return;  // already handed over (the embed can say it twice)
  const there = desktop() && await hiddenYouTubeAvailable().then(answer => answer.available, () => false);
  if (mine !== ticket || state.video !== video || state.hidden) return;
  if (there) { frame = null; set({ hidden: true, starting: false }); playHidden(video); return; }
  if (at + 1 < queue.length) go(at + 1);
  else fail(BLOCKED);
}

/** Plays these videos from the first; the rest are the queue for «siguiente». */
/** Plays these videos from the first, if this request (its ticket) is still the last one; false when it is not. */
export function playYouTube(videos: Video[], query = '', mine = ticket): boolean {
  if (mine !== ticket) return false;
  if (state.hidden) { order({ action: 'stop' }); set({ hidden: false }); }
  queue = videos.filter(video => VIDEO_ID.test(video.id)).slice(0, 20);
  asked = query; at = -1;
  go(0);
  return true;
}
export const youtubeActive = () => state.video !== null && !state.error;
export function stopYouTube() {
  ticket += 1; queue = []; at = -1; frame = null; window.clearTimeout(watchdog); window.clearTimeout(alive);
  if (state.hidden) order({ action: 'stop' });
  set({ video: null, playing: false, position: 0, duration: 0, error: '', hidden: false, ad: false, starting: false });
}
export function youtubeControl(action: 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'louder' | 'quieter') {
  if (state.hidden) { hiddenControl(action); return; }
  if (action === 'toggle') send(state.playing ? 'pauseVideo' : 'playVideo');
  else if (action === 'play') send('playVideo');
  else if (action === 'pause') send('pauseVideo');
  else if (action === 'next') go(Math.min(at + 1, queue.length - 1));
  else if (action === 'previous') { if (state.position > 4) send('seekTo', [0, true]); else go(Math.max(at - 1, 0)); }
  else { const volume = Math.max(0, Math.min(100, state.volume + (action === 'louder' ? 10 : -10))); send('setVolume', [volume]); set({ volume }); }
}

function hiddenControl(action: Parameters<typeof youtubeControl>[0]) {
  if (action === 'toggle') order({ action: state.playing ? 'pause' : 'resume' });
  else if (action === 'play') order({ action: 'resume' });
  else if (action === 'pause') order({ action: 'pause' });
  else if (action === 'next') go(Math.min(at + 1, queue.length - 1));
  else if (action === 'previous') { if (state.position > 4) order({ action: 'seek', seconds: 0 }); else go(Math.max(at - 1, 0)); }
  else { const volume = Math.max(0, Math.min(100, state.volume + (action === 'louder' ? 10 : -10))); order({ action: 'volume', volume }); set({ volume }); }
}

// What the hidden window says (the desktop app hands it over already checked): only about the video playing now.
type Hidden = { id: string; state: string; t: number; d: number; title: string; ad: boolean; volume: number };
if (typeof window !== 'undefined') window.addEventListener('agora:youtube', event => {
  const info = (event as CustomEvent<Hidden>).detail;
  if (!state.hidden || !state.video || !info || info.id !== state.video.id) return;
  window.clearTimeout(alive);
  if (info.state === 'playing') { const mine = ticket; alive = window.setTimeout(() => { if (mine === ticket && state.hidden) fail('YouTube ha dejado de responder.'); }, SILENT); }
  if ((info.state === 'playing' || info.state === 'paused') && started !== info.id) {
    started = info.id;
    // A new page starts at YouTube's volume: the one chosen in AgoraOne carries on.
    if (Math.abs(info.volume - state.volume) > 1) order({ action: 'volume', volume: state.volume });
  }
  if (info.state === 'ended') { if (at + 1 < queue.length) go(at + 1); else stopYouTube(); return; }
  if (info.state === 'error') { if (at + 1 < queue.length) go(at + 1); else fail('YouTube no deja reproducir este vídeo.'); return; }
  set({ playing: info.state === 'playing', ad: info.ad, ...(info.ad ? {} : { position: info.t, ...(info.d > 0 ? { duration: info.d } : {}) }) });
});

// What the player says: progress, state and errors. Only from YouTube's embed and only from our own frame.
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  if (event.origin !== EMBED || !frame || event.source !== frame.contentWindow || typeof event.data !== 'string') return;
  let data: { event?: string; info?: unknown };
  try { data = JSON.parse(event.data); } catch { return; }
  heard = true;
  // The first message (initialDelivery) carries the whole state; the later ones (infoDelivery), what changed.
  if ((data.event === 'infoDelivery' || data.event === 'initialDelivery') && data.info && typeof data.info === 'object') {
    const info = data.info as { currentTime?: number; duration?: number; playerState?: number; volume?: number };
    if (!embedAlive && ((info.duration ?? 0) > 0 || (info.currentTime ?? 0) > 0 || [1, 2, 3, 5].includes(info.playerState ?? -1))) {
      embedAlive = true;
      set({ starting: false });
    }
    set({ ...(typeof info.currentTime === 'number' ? { position: info.currentTime } : {}), ...(typeof info.duration === 'number' && info.duration > 0 ? { duration: info.duration } : {}),
      ...(typeof info.playerState === 'number' ? { playing: info.playerState === 1 } : {}), ...(typeof info.volume === 'number' ? { volume: info.volume } : {}) });
    if (info.playerState === 0) { if (at + 1 < queue.length) go(at + 1); else stopYouTube(); }  // the last one ended: the player goes
  } else if (data.event === 'onError') {
    // 101 and 150: the owner does not allow it outside YouTube (record labels often do): the hidden window, or the next.
    void refused();
  }
});

/** The small player, always on screen while something plays, in every section. */
export function YouTubeMini() {
  const now = useYouTube();
  if (!now.video) return now.error ? <aside className="yt-mini" aria-label="YouTube en AgoraOne" role="alert">
    <div className="yt-head"><strong>YouTube</strong><button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={stopYouTube}>×</button></div>
    <small className="dock-note">{now.error}</small>
    {asked && <button type="button" className="button" onClick={() => { void openYouTube(asked).catch(() => undefined); stopYouTube(); }}>Abrir en YouTube</button>}
  </aside> : null;
  const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  if (now.hidden) return <aside className="yt-mini" aria-label="YouTube en AgoraOne">
    <div className="yt-head"><strong title={now.video.title}>{now.video.title}</strong>
      <button type="button" className="icon-button" aria-label="Parar YouTube" onClick={stopYouTube}>×</button></div>
    <small className="dock-note" role="status">{now.ad ? 'Anuncio de YouTube: se salta en cuanto deja.'
      : now.duration ? `${now.playing ? 'Suena' : 'En pausa'} · ${clock(now.position)} / ${clock(now.duration)}` : 'Abriendo el vídeo desde YouTube en segundo plano, unos segundos…'}</small>
    <small className="dock-note">Desde YouTube, en una ventana oculta de AgoraOne (el vídeo no deja verse fuera de su web).</small>
  </aside>;
  const src = `${EMBED}/embed/${now.video.id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`;
  const attach = (node: HTMLIFrameElement | null) => { if (node) frame = node; };
  // «Listening» until the player answers (the first message can be lost while it starts), a few seconds at most.
  const listen = () => {
    pageLoaded();
    const mine = frame;
    const knock = (left: number) => { if (heard || left === 0 || frame !== mine) return;
      mine?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'agoraone', channel: 'widget' }), EMBED);
      window.setTimeout(() => knock(left - 1), 1000); };
    knock(10);
  };
  return <aside className="yt-mini" aria-label="YouTube en AgoraOne">
    <div className="yt-head"><strong title={now.video.title}>{now.video.title}</strong>
      <button type="button" className="icon-button" aria-label="Parar YouTube" onClick={stopYouTube}>×</button></div>
    {now.starting && <small className="dock-note" role="status">Preparando el vídeo…</small>}
    <iframe key={now.video.id} ref={attach} onLoad={listen} src={src} title={`YouTube: ${now.video.title}`}
      allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"/>
  </aside>;
}
