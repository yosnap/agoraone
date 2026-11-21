import { useRef, useState } from 'react';
import { getSummarizers, levelLabels, type Level, type Summarizer } from '../api/core';
import { hereLabel, meetingSourcesLabel, recordsSystemAudio } from '../ui/platform';
import { MusicCard } from './music-card';
import { moduleOn, useModules } from '../shell/modules';
import { lastChoice, stopRecording, toggleQuickRecording, useMeetingRecorder } from '../meetings/meeting-recorder';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** At the foot of the brain: the meeting being recorded (time, how loud your microphone is, who will
 * summarize it) and the music card (what plays, its controls and «pon …»). */
export function BrainDock() {
  const recorder = useMeetingRecorder();
  const [who, setWho] = useState<Record<Level, Summarizer> | null>(null);
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getSummarizers().then(setWho).catch(() => setWho(null)); }
  const live = recorder.phase === 'recording' || recorder.phase === 'stopping';
  const choice = lastChoice();
  const modules = useModules();
  const meetings = moduleOn(modules, 'reuniones');
  return <div className="brain-dock">
    {meetings && !live && <section className="dock-card dock-record-idle" aria-label="Grabar una reunión">
      <div className="dock-head"><span className="command-dot" aria-hidden="true"/><strong>Grabar una reunión</strong></div>
      <small>{meetingSourcesLabel} {levelLabels[choice.confidentiality]} · se resumirá con {who ? who[choice.confidentiality].label : '…'}.</small>
      {recorder.error && <small className="dock-note" role="alert">{recorder.error}</small>}
      <div className="dock-foot"><small>Título y opciones en Reuniones</small>
        <button type="button" className="button primary dock-record-button" onClick={toggleQuickRecording} disabled={recorder.phase === 'starting'}>
          <span className="command-dot" aria-hidden="true"/>{recorder.phase === 'starting' ? 'Empezando…' : 'Grabar'}</button></div>
    </section>}
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
        <small>{recorder.note ? 'no se graba (mira el aviso)' : recordsSystemAudio ? `se graba en ${hereLabel}` : 'no se graba en Windows'}</small>
      </div>
      {recorder.note && <small className="dock-note">{recorder.note}</small>}
      <div className="dock-foot">
        <small>{levelLabels[recorder.confidentiality]} · al parar se resume con {who ? who[recorder.confidentiality].label : '…'}</small>
        <button type="button" className="button" onClick={stopRecording} disabled={recorder.phase === 'stopping'}>Parar</button>
      </div>
    </section>}
    {moduleOn(modules, 'musica') && <MusicCard/>}
  </div>;
}
