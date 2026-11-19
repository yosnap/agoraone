import { useCallback, useRef, useState } from 'react';
import { controlMusic, getLibrary, getMusic, libraryCover, playMusic, playerCover, searchYouTube, setMusicLevel, type MusicAction, type MusicState } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { localControl, localSeek, localVolume, playLocal, useLocalPlayer } from './local-player';
import { MusicSlider } from './music-slider';
import { askTicket, playYouTube, stopYouTube, useYouTube, youtubeActive, youtubeControl, youtubeProblem, youtubeSeek, youtubeVolume } from './youtube-player';

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
  const covered = useRef('');
  const [cover, setCover] = useState<{ key: string; url: string | null } | null>(null);
  // Every change of cover goes through here, so a local picture is always freed when it stops being shown.
  const shownCover = useRef<string | null>(null);  // the picture on screen, to free it also when the card leaves
  const replaceCover = (next: { key: string; url: string | null } | null) => {
    if (shownCover.current?.startsWith('blob:') && shownCover.current !== next?.url) URL.revokeObjectURL(shownCover.current);
    shownCover.current = next?.url ?? null;
    setCover(next);
  };
  const alive = useRef(false);
  const read = useCallback(() => {
    window.clearTimeout(timer.current);
    void getMusic().then(next => { if (alive.current) setState(next); })
      .catch(() => { if (alive.current) setState(current => current ?? { players: [], note: 'No puedo leer la música ahora.' }); })
      .finally(() => { if (alive.current) timer.current = window.setTimeout(read, REFRESH); });
  }, []);
  // Reads while the card is on the page and stops when it leaves (a ref callback, no effect); the first time it
  // also learns whether there is a library, to offer it first.
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    alive.current = true; read();
    // Without a library of their own, YouTube: Apple Music only searches the user's Apple Music library.
    void getLibrary('').then(found => setTarget(current => current ?? (found.folders.length ? 'local' : 'youtube'))).catch(() => setTarget(current => current ?? 'youtube'));
    return () => { alive.current = false; window.clearTimeout(timer.current); covered.current = ''; if (shownCover.current?.startsWith('blob:')) URL.revokeObjectURL(shownCover.current); shownCover.current = null; };
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
    // This request's place, taken now: anything asked after it (to Watson, by voice) wins.
    const mine = askTicket();
    // YouTube, in AgoraOne's own player; `before` says why it went there.
    const onYouTube = async (before = '') => {
      const { videos } = await searchYouTube(wanted);
      if (!videos.length) throw new Error(`No encuentro «${wanted}» en YouTube.`);
      const playing = (await getMusic().catch(() => null))?.players[0];
      if (!playYouTube(videos, wanted, mine)) return false;  // something else was asked for meanwhile
      if (!youtubeActive()) throw new Error(`${before}${youtubeProblem()}`);  // e.g. the browser preview
      if (local.playing) localControl('pause');
      if (playing?.state === 'playing' && (playing.player === 'music' || playing.player === 'spotify')) await controlMusic(playing.player, 'pause').catch(() => undefined);
      setMessage(`${before}En YouTube: «${videos[0].title}».`);
      return true;
    };
    try {
      const where = target ?? 'youtube';
      if (where === 'youtube') {
        if (!await onYouTube()) return;
      }
      else if (where === 'local') {
        const found = await getLibrary(wanted);
        // Not in the user's own music: YouTube, saying so, instead of stopping at «not found».
        if (!found.folders.length || !found.tracks.length) {
          if (!await onYouTube(found.folders.length ? 'No está en tu biblioteca. ' : 'No tienes carpeta de música. ')) return;
          setQuery('');
          return;
        }
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
    ? { title: tube.video.title, artist: tube.video.channel, source: 'YouTube', playing: tube.playing, position: tube.position, duration: tube.duration, volume: tube.volume,
      cover: `youtube:${tube.video.id}` }
    : local.track
    ? { title: local.track.title, artist: local.track.artist, source: 'Tu biblioteca', playing: local.playing, position: local.position, duration: local.duration, volume: local.volume,
      cover: `local:${local.track.id}` }
    : outside?.title ? { title: outside.title, artist: outside.artist ?? null, source: outside.name, playing: outside.state === 'playing', position: outside.position ?? null,
      duration: outside.duration ?? null, volume: outside.volume ?? null, cover: `${outside.player}:${outside.title}|${outside.artist ?? ''}|${outside.album ?? ''}` }
    : null;
  // The cover: YouTube's own picture of the video, the one inside the song of the library, or the player's artwork.
  // Asked once per song while rendering (no effect); a song without one keeps the note.
  if (showing && covered.current !== showing.cover) {
    covered.current = showing.cover;
    const key = showing.cover, [kind, ...rest] = key.split(':'), id = rest.join(':');
    if (kind === 'youtube') replaceCover({ key, url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
    else void (kind === 'local' ? libraryCover(id) : playerCover(kind, id)).then(url => {
      if (covered.current === key) replaceCover({ key, url }); else if (url) URL.revokeObjectURL(url);  // the song changed meanwhile
      // No picture (or a player that was slow to answer): asked again a little later, on a following reading.
      if (!url) window.setTimeout(() => { if (covered.current === key) covered.current = ''; }, 15_000);
    }, () => window.setTimeout(() => { if (covered.current === key) covered.current = ''; }, 15_000));
  }
  const picture = showing && cover?.key === showing.cover ? cover.url : null;
  const seek = (seconds: number) => {
    if (tube.video) youtubeSeek(seconds);
    else if (local.track) localSeek(seconds);
    else if (outside) void setMusicLevel(outside.player, 'seek', seconds).then(setState, failure => setError(failure instanceof Error ? failure.message : 'No se pudo.'));
  };
  const loud = (volume: number) => {
    if (tube.video) youtubeVolume(volume);
    else if (local.track) localVolume(volume);
    else if (outside) void setMusicLevel(outside.player, 'volume', volume).then(setState, failure => setError(failure instanceof Error ? failure.message : 'No se pudo.'));
  };
  return <section className="dock-card dock-music" aria-label="Música" ref={attach}>
    <div className="dock-cover" aria-hidden="true">{picture
      ? <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => replaceCover(null)}/> : '♫'}</div>
    <div className="music-body">
      {showing ? <>
        <div className="music-head"><strong title={`${showing.title} · ${showing.artist ?? ''}`}>{showing.title}{showing.artist ? ` · ${showing.artist}` : ''}</strong><span className="lately-tag">{showing.source}</span></div>
        <MusicSlider label="Punto de la canción" value={showing.position ?? 0} max={showing.duration ?? 0} onCommit={seek} format={value => `${clock(value)} de ${clock(showing.duration)}`}/>
        <div className="music-controls">
          <button type="button" className="music-button" aria-label="Anterior" onClick={() => void act('previous')}>⏮</button>
          <button type="button" className="music-button main" aria-label={showing.playing ? 'Pausar' : 'Reproducir'} onClick={() => void act('toggle')}>{showing.playing ? '❚❚' : '▶'}</button>
          <button type="button" className="music-button" aria-label="Siguiente" onClick={() => void act('next')}>⏭</button>
          {showing.volume != null && <span className="music-volume"><span aria-hidden="true">{showing.volume === 0 ? '🔇' : '🔊'}</span>
            <MusicSlider label="Volumen" value={showing.volume} max={100} onCommit={loud} format={value => `${Math.round(value)} %`}/></span>}
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
