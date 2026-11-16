import { useSyncExternalStore } from 'react';
import { openYouTube, type Video } from '../api/core';

/** YouTube inside AgoraOne (1.7): «pon … en YouTube» plays here, in one small player for the whole app (it keeps
 * playing across sections) that is only controlled from AgoraOne: the music card, Watson and its own ✕. The player
 * is YouTube's embed (no cookies domain) driven by messages; YouTube's script never runs inside AgoraOne. A video
 * that cannot be embedded is skipped. */
type State = { video: Video | null; playing: boolean; position: number; duration: number; volume: number; error: string };
const EMBED = 'https://www.youtube-nocookie.com';
let state: State = { video: null, playing: false, position: 0, duration: 0, volume: 100, error: '' };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
export const useYouTube = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);

let queue: Video[] = [];
let at = 0;
let frame: HTMLIFrameElement | null = null;
let asked = '';

const send = (func: string, args: unknown[] = []) => frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), EMBED);

function go(index: number) {
  const video = queue[index];
  if (!video) { set({ playing: false }); return; }
  at = index;
  set({ video, playing: false, position: 0, duration: 0, error: '' });
}

/** Plays these videos from the first; the rest are the queue for «siguiente». */
export function playYouTube(videos: Video[], query = '') { queue = videos.slice(0, 20); asked = query; go(0); }
export const youtubeActive = () => state.video !== null;
export function stopYouTube() { queue = []; frame = null; set({ video: null, playing: false, position: 0, duration: 0, error: '' }); }
export function youtubeControl(action: 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'louder' | 'quieter') {
  if (action === 'toggle') send(state.playing ? 'pauseVideo' : 'playVideo');
  else if (action === 'play') send('playVideo');
  else if (action === 'pause') send('pauseVideo');
  else if (action === 'next') go(Math.min(at + 1, queue.length - 1));
  else if (action === 'previous') { if (state.position > 4) send('seekTo', [0, true]); else go(Math.max(at - 1, 0)); }
  else { const volume = Math.max(0, Math.min(100, state.volume + (action === 'louder' ? 10 : -10))); send('setVolume', [volume]); set({ volume }); }
}

// What the player says: progress, state and errors. Only from YouTube's embed and only from our own frame.
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  if (event.origin !== EMBED || !frame || event.source !== frame.contentWindow || typeof event.data !== 'string') return;
  let data: { event?: string; info?: unknown };
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.event === 'infoDelivery' && data.info && typeof data.info === 'object') {
    const info = data.info as { currentTime?: number; duration?: number; playerState?: number; volume?: number };
    set({ ...(typeof info.currentTime === 'number' ? { position: info.currentTime } : {}), ...(typeof info.duration === 'number' && info.duration > 0 ? { duration: info.duration } : {}),
      ...(typeof info.playerState === 'number' ? { playing: info.playerState === 1 } : {}), ...(typeof info.volume === 'number' ? { volume: info.volume } : {}) });
    if (info.playerState === 0) { if (at + 1 < queue.length) go(at + 1); else set({ playing: false }); }
  } else if (data.event === 'onError') {
    // 101 and 150: the owner does not allow it outside YouTube (record labels often do). Try the next one.
    if (at + 1 < queue.length) go(at + 1);
    else set({ error: 'Ninguno de estos vídeos deja reproducirse fuera de YouTube: las discográficas suelen bloquearlo.', playing: false });
  }
});

/** The small player, always on screen while something plays, in every section. */
export function YouTubeMini() {
  const now = useYouTube();
  if (!now.video) return null;
  const src = `${EMBED}/embed/${now.video.id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`;
  const attach = (node: HTMLIFrameElement | null) => { if (node) frame = node; };
  const listen = () => frame?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'agoraone', channel: 'widget' }), EMBED);
  return <aside className="yt-mini" aria-label="YouTube en AgoraOne">
    <div className="yt-head"><strong title={now.video.title}>{now.video.title}</strong>
      <button type="button" className="icon-button" aria-label="Parar YouTube" onClick={stopYouTube}>×</button></div>
    <iframe key={now.video.id} ref={attach} onLoad={listen} src={src} title={`YouTube: ${now.video.title}`}
      allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"/>
    {now.error && <><small className="dock-note" role="alert">{now.error}</small>
      {asked && <button type="button" className="button" onClick={() => { void openYouTube(asked).catch(() => undefined); stopYouTube(); }}>Abrir en YouTube</button>}</>}
  </aside>;
}
