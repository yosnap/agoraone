import { useSyncExternalStore } from 'react';
import { trackUrl, type LibraryTrack } from '../api/core';

/** AgoraOne's own player for the user's music (1.5): one for the whole app, so it keeps playing across
 * sections. A queue (the search that started it), play/pause, next and previous, and its progress. */
type State = { track: LibraryTrack | null; playing: boolean; position: number; duration: number; error: string };
let state: State = { track: null, playing: false, position: 0, duration: 0, error: '' };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
export const useLocalPlayer = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);

let audio: HTMLAudioElement | null = null;
let queue: LibraryTrack[] = [];
let at = 0;
let url: string | null = null;

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.addEventListener('timeupdate', () => set({ position: audio!.currentTime, duration: Number.isFinite(audio!.duration) ? audio!.duration : 0 }));
  audio.addEventListener('play', () => set({ playing: true }));
  audio.addEventListener('pause', () => set({ playing: false }));
  audio.addEventListener('ended', () => { if (at + 1 < queue.length) void go(at + 1); else set({ playing: false }); });
  return audio;
}

async function go(index: number) {
  const track = queue[index];
  if (!track) return;
  at = index;
  set({ track, error: '', position: 0, duration: 0 });
  try {
    const made = await trackUrl(track.id);
    if (url) URL.revokeObjectURL(url);
    url = made;
    const player = element();
    player.src = made;
    await player.play();
  } catch (failure) { set({ error: failure instanceof Error ? failure.message : 'No se pudo reproducir.', playing: false }); }
}

/** Plays these tracks from the first (or the one given). */
export function playLocal(tracks: LibraryTrack[], start = 0) { queue = tracks.slice(0, 200); void go(start); }
export const localActive = () => state.track !== null;
export function localControl(action: 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'louder' | 'quieter') {
  const player = element();
  if (action === 'toggle') { if (player.paused) void player.play(); else player.pause(); }
  else if (action === 'play') void player.play();
  else if (action === 'pause') player.pause();
  else if (action === 'next') void go(Math.min(at + 1, queue.length - 1));
  else if (action === 'previous') { if (player.currentTime > 4) player.currentTime = 0; else void go(Math.max(at - 1, 0)); }
  else if (action === 'louder') player.volume = Math.min(1, player.volume + 0.1);
  else player.volume = Math.max(0, player.volume - 0.1);
}
