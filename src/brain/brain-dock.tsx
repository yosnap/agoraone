import { useRef, useState } from 'react';
import { getSummarizers, levelLabels, type Level, type Summarizer } from '../api/core';
import { stopRecording, useMeetingRecorder } from '../meetings/meeting-recorder';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** At the foot of the brain: the meeting being recorded (time, how loud your microphone is, who will
 * summarize it) and, from 1.5, the music player, marked pending until then and never simulated. */
export function BrainDock() {
  const recorder = useMeetingRecorder();
  const [who, setWho] = useState<Record<Level, Summarizer> | null>(null);
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getSummarizers().then(setWho).catch(() => setWho(null)); }
  const live = recorder.phase === 'recording' || recorder.phase === 'stopping';
  return <div className="brain-dock">
    {live && <section className="dock-card dock-recording" aria-label="Grabación de la reunión">
      <div className="dock-head">
        <span className="command-dot on" aria-hidden="true"/>
        <strong>{recorder.phase === 'stopping' ? 'Cerrando la grabación…' : `Grabando · ${recorder.title}`}</strong>
        <span className="dock-time">{clock(recorder.seconds)}</span>
      </div>
      <div className="dock-levels">
        <span>Tú</span>
        <span className="dock-meter" role="meter" aria-label="Volumen de tu micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(recorder.level * 100)}>
          <span style={{ width: `${Math.round(recorder.level * 100)}%` }}/></span>
        <span>Los demás</span>
        <small>{recorder.note ? 'no se graba (mira el aviso)' : 'se graba en este Mac'}</small>
      </div>
      {recorder.note && <small className="dock-note">{recorder.note}</small>}
      <div className="dock-foot">
        <small>{levelLabels[recorder.confidentiality]} · al parar se resume con {who ? who[recorder.confidentiality].label : '…'}</small>
        <button type="button" className="button" onClick={stopRecording} disabled={recorder.phase === 'stopping'}>Parar</button>
      </div>
    </section>}
    <section className="dock-card dock-music" aria-label="Música (pendiente)">
      <div className="dock-cover" aria-hidden="true">♫</div>
      <div>
        <strong>Música</strong>
        <small>Pendiente · versión 1.5. Desde aquí podrás pedir y controlar Apple Music, Spotify, tu biblioteca y YouTube, también por voz.</small>
      </div>
    </section>
  </div>;
}
