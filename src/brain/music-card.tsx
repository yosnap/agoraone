import { useCallback, useRef, useState } from 'react';
import { controlMusic, getMusic, playMusic, type MusicAction, type MusicState } from '../api/core';
import { ModernSelect } from '../ui/modern-select';

const REFRESH = 3000;
const clock = (seconds: number | null | undefined) => seconds == null ? '–:––' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** The music card at the brain's foot (1.5): what Apple Music or Spotify is playing, its controls and «pon …».
 * It only reads players that are already open; asking it to play something may open the chosen one. */
export function MusicCard() {
  const [state, setState] = useState<MusicState | null>(null);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<'music' | 'spotify'>('music');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const timer = useRef(0);
  const alive = useRef(false);
  const read = useCallback(() => {
    window.clearTimeout(timer.current);
    void getMusic().then(next => { if (alive.current) setState(next); }).catch(() => undefined)
      .finally(() => { if (alive.current) timer.current = window.setTimeout(read, REFRESH); });
  }, []);
  // Reads while the card is on the page and stops when it leaves (a ref callback, no effect).
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    alive.current = true; read();
    return () => { alive.current = false; window.clearTimeout(timer.current); };
  }, [read]);
  const now = state?.players[0];
  const act = async (action: MusicAction) => {
    if (!now) return;
    setError('');
    try { setState(await controlMusic(now.player, action)); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo.'); }
  };
  const ask = async () => {
    if (!query.trim()) return;
    setError(''); setMessage('');
    try { const done = await playMusic(now && (now.player === 'music' || now.player === 'spotify') ? now.player : target, query); setMessage(done.done); setQuery(''); setState(done); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo.'); }
  };
  const playing = now?.state === 'playing';
  const progress = now?.duration && now.position != null ? Math.min(100, (now.position / now.duration) * 100) : 0;
  return <section className="dock-card dock-music" aria-label="Música" ref={attach}>
    <div className="dock-cover" aria-hidden="true">♫</div>
    <div className="music-body">
      {now && now.title ? <>
        <div className="music-head"><strong title={`${now.title} · ${now.artist ?? ''}`}>{now.title}{now.artist ? ` · ${now.artist}` : ''}</strong><span className="lately-tag">{now.name}</span></div>
        <div className="music-bar" aria-hidden="true"><span style={{ width: `${progress}%` }}/></div>
        <div className="music-controls">
          <button type="button" className="music-button" aria-label="Anterior" onClick={() => void act('previous')}>⏮</button>
          <button type="button" className="music-button main" aria-label={playing ? 'Pausar' : 'Reproducir'} onClick={() => void act('toggle')}>{playing ? '❚❚' : '▶'}</button>
          <button type="button" className="music-button" aria-label="Siguiente" onClick={() => void act('next')}>⏭</button>
          <button type="button" className="music-button" aria-label="Bajar el volumen" onClick={() => void act('quieter')}>−</button>
          <button type="button" className="music-button" aria-label="Subir el volumen" onClick={() => void act('louder')}>+</button>
          <small className="music-time">{clock(now.position)} / {clock(now.duration)}</small>
        </div>
      </> : <div className="music-head"><strong>Música</strong><small>{now?.problem ?? state?.note ?? 'Leyendo…'}</small></div>}
      <form className="music-ask" onSubmit={event => { event.preventDefault(); void ask(); }}>
        <label htmlFor="music-query" className="visually-hidden">Qué quieres escuchar</label>
        <input id="music-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Pon… (canción, artista o lista)" maxLength={120}/>
        {!now && <ModernSelect value={target} onChange={value => setTarget(value as 'music' | 'spotify')} options={[{ value: 'music', label: 'Música' }, { value: 'spotify', label: 'Spotify' }]}/>}
        <button type="submit" className="button" disabled={!query.trim()}>Poner</button>
      </form>
      {message && <small className="ok-note" role="status">{message}</small>}
      {error && <small className="dock-note" role="alert">{error}</small>}
    </div>
  </section>;
}
