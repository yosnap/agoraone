import { useCallback, useRef, useState } from 'react';
import { controlMusic, getLibrary, getMusic, playMusic, searchYouTube, type MusicAction, type MusicState } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { localControl, playLocal, useLocalPlayer } from './local-player';
import { askTicket, playYouTube, stopYouTube, useYouTube, youtubeControl } from './youtube-player';

const REFRESH = 3000;
const clock = (seconds: number | null | undefined) => seconds == null ? '–:––' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
type Target = 'local' | 'music' | 'spotify' | 'youtube';
const targets: { value: Target; label: string }[] = [
  { value: 'local', label: 'Tu biblioteca' }, { value: 'music', label: 'Música' }, { value: 'spotify', label: 'Spotify' }, { value: 'youtube', label: 'YouTube' },
];

/** The music card at the brain's foot (1.5): what plays (the user's own library in AgoraOne's player, or Apple
 * Music or Spotify, or YouTube in AgoraOne's own small player), its controls and «pon …» in the source the user
 * picks. Players are only read when already open. */
export function MusicCard() {
  const [state, setState] = useState<MusicState | null>(null);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const local = useLocalPlayer();
  const tube = useYouTube();
  const timer = useRef(0);
  const alive = useRef(false);
  const read = useCallback(() => {
    window.clearTimeout(timer.current);
    void getMusic().then(next => { if (alive.current) setState(next); }).catch(() => undefined)
      .finally(() => { if (alive.current) timer.current = window.setTimeout(read, REFRESH); });
  }, []);
  // Reads while the card is on the page and stops when it leaves (a ref callback, no effect); the first time it
  // also learns whether there is a library, to offer it first.
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    alive.current = true; read();
    // Without a library of their own, YouTube: Apple Music only searches the user's Apple Music library.
    void getLibrary('').then(found => setTarget(current => current ?? (found.folders.length ? 'local' : 'youtube'))).catch(() => setTarget(current => current ?? 'youtube'));
    return () => { alive.current = false; window.clearTimeout(timer.current); };
  }, [read]);
  const outside = state?.players[0];
  // What the card says when nothing plays: reading only until the first answer arrives.
  const idle = !state ? 'Leyendo…' : outside?.problem ?? state.note
    ?? (outside ? `${outside.name} está abierto, sin nada sonando. Pide algo con «Pon…».` : 'Nada sonando. Pide algo con «Pon…».');
  const act = async (action: MusicAction) => {
    setError('');
    if (tube.video) { youtubeControl(action); return; }
    if (local.track) { localControl(action); return; }
    if (!outside) return;
    try { setState(await controlMusic(outside.player, action)); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo.'); }
  };
  const ask = async () => {
    const wanted = query.trim();
    if (!wanted) return;
    setError(''); setMessage('');
    try {
      const where = target ?? 'youtube';
      if (where === 'youtube') {
        const mine = askTicket();
        const { videos } = await searchYouTube(wanted);
        const playing = (await getMusic().catch(() => null))?.players[0];
        if (!playYouTube(videos, wanted, mine)) return;  // something else was asked for meanwhile
        if (local.playing) localControl('pause');
        if (playing?.state === 'playing' && (playing.player === 'music' || playing.player === 'spotify')) await controlMusic(playing.player, 'pause').catch(() => undefined);
        setMessage(`En YouTube: «${videos[0].title}».`);
      }
      else if (where === 'local') {
        const found = await getLibrary(wanted);
        if (!found.folders.length) throw new Error('Elige primero tu carpeta de música en Ajustes › Voz.');
        if (!found.tracks.length) throw new Error(`No encuentro «${wanted}» en tu biblioteca.`);
        if (outside?.state === 'playing' && (outside.player === 'music' || outside.player === 'spotify')) await controlMusic(outside.player, 'pause').catch(() => undefined);
        playLocal(found.tracks);
        setMessage(`Reproduciendo ${found.tracks.length === 1 ? '1 canción' : `${found.tracks.length} canciones`} de tu biblioteca.`);
      } else {
        if (local.playing) localControl('pause');
        stopYouTube();
        const done = await playMusic(where, wanted);
        setMessage(done.done); setState(done);
      }
      setQuery('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo.'); }
  };
  const showing = tube.video
    ? { title: tube.video.title, artist: tube.video.channel, source: 'YouTube', playing: tube.playing, position: tube.position, duration: tube.duration }
    : local.track
    ? { title: local.track.title, artist: local.track.artist, source: 'Tu biblioteca', playing: local.playing, position: local.position, duration: local.duration }
    : outside?.title ? { title: outside.title, artist: outside.artist ?? null, source: outside.name, playing: outside.state === 'playing', position: outside.position ?? null, duration: outside.duration ?? null }
    : null;
  const progress = showing?.duration && showing.position != null ? Math.min(100, (showing.position / showing.duration) * 100) : 0;
  return <section className="dock-card dock-music" aria-label="Música" ref={attach}>
    <div className="dock-cover" aria-hidden="true">♫</div>
    <div className="music-body">
      {showing ? <>
        <div className="music-head"><strong title={`${showing.title} · ${showing.artist ?? ''}`}>{showing.title}{showing.artist ? ` · ${showing.artist}` : ''}</strong><span className="lately-tag">{showing.source}</span></div>
        <div className="music-bar" aria-hidden="true"><span style={{ width: `${progress}%` }}/></div>
        <div className="music-controls">
          <button type="button" className="music-button" aria-label="Anterior" onClick={() => void act('previous')}>⏮</button>
          <button type="button" className="music-button main" aria-label={showing.playing ? 'Pausar' : 'Reproducir'} onClick={() => void act('toggle')}>{showing.playing ? '❚❚' : '▶'}</button>
          <button type="button" className="music-button" aria-label="Siguiente" onClick={() => void act('next')}>⏭</button>
          <button type="button" className="music-button" aria-label="Bajar el volumen" onClick={() => void act('quieter')}>−</button>
          <button type="button" className="music-button" aria-label="Subir el volumen" onClick={() => void act('louder')}>+</button>
          <small className="music-time">{clock(showing.position)} / {clock(showing.duration)}</small>
        </div>
      </> : <div className="music-head"><strong>Música</strong><small>{idle}</small></div>}
      <form className="music-ask" onSubmit={event => { event.preventDefault(); void ask(); }}>
        <label htmlFor="music-query" className="visually-hidden">Qué quieres escuchar</label>
        <input id="music-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Pon… (canción, artista o lista)" maxLength={120}/>
        <ModernSelect value={target ?? 'youtube'} onChange={value => setTarget(value as Target)} options={targets}/>
        <button type="submit" className="button" disabled={!query.trim()}>Poner</button>
      </form>
      {(message || local.error) && <small className={local.error ? 'dock-note' : 'ok-note'} role="status">{local.error || message}</small>}
      {error && <small className="dock-note" role="alert">{error}</small>}
    </div>
  </section>;
}
