import { useRef, useState, type CSSProperties } from 'react';
import { deleteMeeting, getMeetings, getSummarizers, kindLabels, levelLabels, processMeeting, stopMeeting, type Summarizer, type Level, type Meeting, type MeetingList } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { ClientChip, clientHue } from './client-chip';
import { MeetingDetailPanel } from './meeting-detail';
import { forgetMeetingIntent, peekMeetingIntent } from './meeting-intent';
import { asClass, emptyFields, KindFields, useCentralClients, type Fields } from './meeting-kind';
import { lastChoice, rememberChoice, startRecording, stopRecording, useMeetingRecorder } from './meeting-recorder';
import './meetings.css';

const levels: { value: Level; label: string }[] = (Object.keys(levelLabels) as Level[]).map(value => ({ value, label: levelLabels[value] }));
export const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
};
const size = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const when = (stamp: string) => new Date(stamp).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const statusText: Record<Meeting['status'], string> = { recording: 'Grabando', recorded: 'Grabada', interrupted: 'Interrumpida' };
const workText: Partial<Record<Meeting['work'], string>> = { transcribing: 'Transcribiendo en este equipo…', summarizing: 'Resumiendo…', failed: 'No se pudo procesar' };
export const working = (m: Meeting) => m.work === 'transcribing' || m.work === 'summarizing';

const madeBy: Record<string, string> = { claude: 'Resumida por Claude', local: 'Resumida en este Mac con el modelo local', none: 'Sin resumen: solo la transcripción' };

function MeetingRow({ meeting, discreet, onDeleted, onChanged, ours, planned, asked = false }: { meeting: Meeting; discreet: boolean; onDeleted: () => void; onChanged: () => void; ours: boolean; planned?: Summarizer; asked?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(asked);  // opened from the Agenda
  const shown = useRef(false);
  const reveal = (row: HTMLLIElement | null) => { if (row && asked && !shown.current) { shown.current = true; row.scrollIntoView({ block: 'center' }); } };
  const [error, setError] = useState('');
  const process = async (summaryOnly: boolean) => {
    setError('');
    try { await processMeeting(meeting.id, summaryOnly); onChanged(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo empezar.'); }
  };
  const idle = meeting.status !== 'recording' && !working(meeting);
  const hidden = discreet && meeting.confidentiality !== 'normal';
  const remove = async () => {
    setError('');
    try { await deleteMeeting(meeting.id); onDeleted(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo borrar.'); }
  };
  const { clients } = useCentralClients();
  const client = !hidden && meeting.client ? meeting.client : null;
  // No colour while Central is being read, so the rows do not change hue when the list arrives.
  const hue = client && clients ? clientHue(client, clients.map(c => c.name)) : null;
  return <li className={`meeting-row${hue !== null ? ' has-client' : ''}`} ref={reveal} style={hue !== null ? { '--client-hue': hue } as CSSProperties : undefined}>
    <div className="meeting-main">
      <span className="meeting-head">{client && <ClientChip client={client} project={meeting.project} hue={hue}/>}<strong>{hidden ? 'Reunión' : meeting.title}</strong></span>
      <small>{when(meeting.started_at)} · {clock(meeting.seconds)} · {levelLabels[meeting.confidentiality]}</small>
      {!hidden && <small className="muted">{[kindLabels[meeting.kind], meeting.people.length ? `con ${meeting.people.map(p => p.name).join(', ')}` : ''].filter(Boolean).join(' · ')}</small>}
      <small className="muted">Tu micrófono: {meeting.mic_bytes ? size(meeting.mic_bytes) : 'vacío'} · Audio del sistema: {meeting.system_source ? (meeting.system_bytes ? size(meeting.system_bytes) : meeting.status === 'recording' ? 'grabando' : 'vacío') : 'no grabado'}</small>
      {meeting.note && !hidden && <small className="muted">{meeting.note}</small>}
      {meeting.work_error && !hidden && <small className={meeting.work === 'failed' ? 'dictation-error' : 'muted'} role={meeting.work === 'failed' ? 'alert' : undefined}>
        {meeting.work === 'failed' ? 'Error: ' : ''}{meeting.work_error}</small>}
      <small className="meeting-engine">{meeting.summary_by ? madeBy[meeting.summary_by] : planned ? `Se resumirá con: ${planned.label}` : ''}</small>
    </div>
    <span className={`status-badge ${meeting.status === 'recorded' ? 'good' : 'paused'}`}>{statusText[meeting.status]}</span>
    {workText[meeting.work] && <span className="meeting-work" role="status">{workText[meeting.work]}</span>}
    {meeting.status === 'recording' && !ours && <button type="button" className="button" onClick={() => void stopMeeting(meeting.id).then(onChanged, failure => setError(failure instanceof Error ? failure.message : 'No se pudo parar.'))}>
      Parar (se grababa desde otra pantalla)</button>}
    {idle && !hidden && <span className="meeting-actions">
      {meeting.has_transcript && <button type="button" className="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Cerrar' : 'Ver'}</button>}
      {!meeting.has_transcript && <button type="button" className="button primary" onClick={() => void process(false)}>{meeting.work === 'failed' ? 'Reintentar' : 'Transcribir y resumir'}</button>}
      {meeting.has_transcript && (meeting.work === 'failed' || (meeting.summary_by !== 'claude' && meeting.summary_by !== 'local')) &&
        <button type="button" className="button" onClick={() => void process(true)}>Volver a resumir</button>}
    </span>}
    {idle && (confirming
      ? <span className="meeting-confirm" role="group" aria-label="Confirmar borrado">
          <span>¿Borrar el audio de esta reunión?</span>
          <button type="button" className="button danger" onClick={() => void remove()}>Borrar</button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>Cancelar</button>
        </span>
      : <button type="button" className="button" onClick={() => setConfirming(true)}>Borrar</button>)}
    {error && <small className="dictation-error" role="alert">{error}</small>}
    {open && !hidden && meeting.has_transcript && <MeetingDetailPanel key={`${meeting.id}:${meeting.work}`} id={meeting.id} onChanged={onChanged}/>}
  </li>;
}

/** Recording meetings: your microphone and what the computer plays (Meet, Zoom, Teams), in two tracks kept
 * in AgoraOne's data. Recording only starts with the button, and the rail shows it while it lasts. */
export function MeetingsView({ discreet }: { discreet: boolean }) {
  const recorder = useMeetingRecorder();
  const [intent] = useState(peekMeetingIntent);  // what the Agenda asked for, if anything
  const [list, setList] = useState<MeetingList | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(intent?.title ?? '');
  const [level, setLevel] = useState<Level>(() => lastChoice().confidentiality);
  const [system, setSystem] = useState(() => lastChoice().system);
  const [about, setAbout] = useState<Fields>(emptyFields);
  const loaded = useRef<string | null>(null);
  const [who, setWho] = useState<Record<Level, Summarizer> | null>(null);
  const askedWho = useRef(false);
  if (!askedWho.current) { askedWho.current = true; void getSummarizers().then(setWho).catch(() => setWho(null)); }
  const poll = useRef(0);
  // While a meeting is being transcribed or summarized, the list is read again every few seconds.
  const load = () => getMeetings().then(next => {
    setList(next);
    window.clearTimeout(poll.current);
    if (next.meetings.some(working)) poll.current = window.setTimeout(() => void load(), 3000);
  }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las reuniones.'));
  // Load on arrival and again whenever a recording ends (the list shows its tracks).
  const mark = `${recorder.finished}:${recorder.meetingId ?? ''}`;
  if (loaded.current !== mark) { loaded.current = mark; void load(); }
  const busy = recorder.phase !== 'idle';
  return <section className="page meetings-page" aria-labelledby="meetings-title" ref={forgetMeetingIntent}>
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
      </> : <form onSubmit={event => { event.preventDefault(); rememberChoice({ confidentiality: level, system }); void startRecording(title, level, system, asClass(about)).then(() => { setTitle(''); setAbout(emptyFields); }); }}>
        <label className="field">Título<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="Opcional (si no, el tipo, el cliente y la hora)"/></label>
        <KindFields value={about} onChange={setAbout}/>
        <label className="field">Confidencialidad<ModernSelect value={level} options={levels} onChange={value => setLevel(value as Level)}/></label>
        <p className="meeting-engine" role="note">La grabación y la transcripción se hacen en este Mac. Resumen: <strong>{who ? who[level].label : '…'}</strong>.</p>
        <label className="check"><input type="checkbox" checked={system} onChange={event => setSystem(event.target.checked)}/> Grabar también el audio del sistema (los demás)</label>
        {system && list?.system && <p className="fiscal-warning">{list.system}</p>}
        <button type="submit" className="button primary" disabled={busy}>{recorder.phase === 'starting' ? 'Empezando…' : 'Empezar a grabar'}</button>
      </form>}
      {recorder.error && <p className="dictation-error" role="alert">{recorder.error}</p>}
    </article>
    <article className="card" aria-labelledby="recorded-title">
      <div className="card-head"><h2 id="recorded-title">Grabadas</h2></div>
      {!list && !error ? <Loading label="Leyendo las reuniones" lines={2}/>
        : list && (list.meetings.length ? <ul className="meeting-list">{list.meetings.map(m => <MeetingRow key={m.id} meeting={m} discreet={discreet} onDeleted={() => void load()} onChanged={() => void load()} ours={recorder.meetingId === m.id} planned={who?.[m.confidentiality]} asked={intent?.open === m.id}/>)}</ul>
          : <p className="muted">Todavía no hay reuniones grabadas.</p>)}
      {error && <LoadError message={error}/>}
    </article>
  </section>;
}
