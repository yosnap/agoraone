import { useRef, useState } from 'react';
import { deleteMeeting, getMeetings, levelLabels, type Level, type Meeting, type MeetingList } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { startRecording, stopRecording, useMeetingRecorder } from './meeting-recorder';
import './meetings.css';

const levels: { value: Level; label: string }[] = (Object.keys(levelLabels) as Level[]).map(value => ({ value, label: levelLabels[value] }));
export const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
};
const size = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const when = (stamp: string) => new Date(stamp).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const statusText: Record<Meeting['status'], string> = { recording: 'Grabando', recorded: 'Grabada', interrupted: 'Interrumpida' };

function MeetingRow({ meeting, discreet, onDeleted }: { meeting: Meeting; discreet: boolean; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const hidden = discreet && meeting.confidentiality !== 'normal';
  const remove = async () => {
    setError('');
    try { await deleteMeeting(meeting.id); onDeleted(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo borrar.'); }
  };
  return <li className="meeting-row">
    <div className="meeting-main">
      <strong>{hidden ? 'Reunión' : meeting.title}</strong>
      <small>{when(meeting.started_at)} · {clock(meeting.seconds)} · {levelLabels[meeting.confidentiality]}</small>
      <small className="muted">Tu micrófono: {meeting.mic_bytes ? size(meeting.mic_bytes) : 'vacío'} · Audio del sistema: {meeting.system_source ? (meeting.system_bytes ? size(meeting.system_bytes) : meeting.status === 'recording' ? 'grabando' : 'vacío') : 'no grabado'}</small>
      {meeting.note && !hidden && <small className="muted">{meeting.note}</small>}
    </div>
    <span className={`status-badge ${meeting.status === 'recorded' ? 'good' : 'paused'}`}>{statusText[meeting.status]}</span>
    {meeting.status !== 'recording' && (confirming
      ? <span className="meeting-confirm" role="group" aria-label="Confirmar borrado">
          <span>¿Borrar el audio de esta reunión?</span>
          <button type="button" className="button danger" onClick={() => void remove()}>Borrar</button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>Cancelar</button>
        </span>
      : <button type="button" className="button" onClick={() => setConfirming(true)}>Borrar</button>)}
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </li>;
}

/** Recording meetings: your microphone and what the computer plays (Meet, Zoom, Teams), in two tracks kept
 * in AgoraOne's data. Recording only starts with the button, and the rail shows it while it lasts. */
export function MeetingsView({ discreet }: { discreet: boolean }) {
  const recorder = useMeetingRecorder();
  const [list, setList] = useState<MeetingList | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState<Level>('normal');
  const [system, setSystem] = useState(true);
  const loaded = useRef<string | null>(null);
  const load = () => getMeetings().then(setList).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las reuniones.'));
  // Load on arrival and again whenever a recording ends (the list shows its tracks).
  const mark = `${recorder.finished}:${recorder.meetingId ?? ''}`;
  if (loaded.current !== mark) { loaded.current = mark; void load(); }
  const busy = recorder.phase !== 'idle';
  return <section className="page meetings-page" aria-labelledby="meetings-title">
    <div className="eyebrow">REUNIONES{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="meetings-title">Reuniones</h1>
    <p className="page-lead">Graba una reunión de Meet, Zoom o Teams: tu micrófono y lo que suena en el ordenador, en dos pistas. El audio se queda en los datos de AgoraOne (nunca en el vault) hasta que lo borres, y se transcribe en este equipo.</p>
    <article className="card meeting-record" aria-labelledby="record-title">
      <div className="card-head"><h2 id="record-title">{recorder.phase === 'recording' ? 'Grabando' : 'Nueva grabación'}</h2>
        {recorder.phase === 'recording' && <span className="meeting-live" role="status"><span aria-hidden="true">●</span> {clock(recorder.seconds)}</span>}</div>
      {recorder.phase === 'recording' || recorder.phase === 'stopping' ? <>
        <p><strong>{recorder.title}</strong></p>
        {recorder.note && <p className="fiscal-warning">{recorder.note}</p>}
        <p className="muted">Puedes cambiar de sección: la grabación sigue y la barra lateral lo indica. Con altavoces, tu micrófono también recoge a los demás; con auriculares las pistas salen limpias.</p>
        <button type="button" className="button primary" onClick={stopRecording} disabled={recorder.phase === 'stopping'}>{recorder.phase === 'stopping' ? 'Cerrando…' : 'Parar la grabación'}</button>
      </> : <form onSubmit={event => { event.preventDefault(); void startRecording(title, level, system).then(() => setTitle('')); }}>
        <label className="field">Título<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="Reunión del equipo (opcional)"/></label>
        <label className="field">Confidencialidad<ModernSelect value={level} options={levels} onChange={value => setLevel(value as Level)}/></label>
        <label className="check"><input type="checkbox" checked={system} onChange={event => setSystem(event.target.checked)}/> Grabar también el audio del sistema (los demás)</label>
        {system && list?.system && <p className="fiscal-warning">{list.system}</p>}
        <button type="submit" className="button primary" disabled={busy}>{recorder.phase === 'starting' ? 'Empezando…' : 'Empezar a grabar'}</button>
      </form>}
      {recorder.error && <p className="dictation-error" role="alert">{recorder.error}</p>}
    </article>
    <article className="card" aria-labelledby="recorded-title">
      <div className="card-head"><h2 id="recorded-title">Grabadas</h2></div>
      {!list && !error ? <Loading label="Leyendo las reuniones" lines={2}/>
        : list && (list.meetings.length ? <ul className="meeting-list">{list.meetings.map(m => <MeetingRow key={m.id} meeting={m} discreet={discreet} onDeleted={() => void load()}/>)}</ul>
          : <p className="muted">Todavía no hay reuniones grabadas.</p>)}
      {error && <LoadError message={error}/>}
    </article>
  </section>;
}
