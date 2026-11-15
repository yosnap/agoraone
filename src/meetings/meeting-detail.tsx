import { useRef, useState } from 'react';
import { createCard, createVaultNote, getHermesCatalog } from '../api/client';
import { createReminder, getJobsSettings, getMeeting, markMeetingSaved, type MeetingDetail, type MeetingTask } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

type Target = { vaults: { id: string; name: string }[]; central: { id: string; label: string } | null };
const failed = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

/** One task of the summary: it becomes a reminder or a commission for the central bot only when the user
 * confirms it here, one by one. */
function TaskRow({ task, meeting, central }: { task: MeetingTask; meeting: string; central: Target['central'] }) {
  const [asking, setAsking] = useState<'reminder' | 'card' | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const notes = `De la reunión «${meeting}»${task.who ? `. Responsable: ${task.who}` : ''}.`;
  const confirm = async () => {
    setError('');
    try {
      if (asking === 'reminder') {
        await createReminder({ title: task.title, due: task.due ? `${task.due}T09:00:00` : null, notes });
        setDone('Recordatorio creado.');
      } else if (asking === 'card' && central) {
        await createCard(central.id, { title: task.title, body: notes });
        setDone(`Encargo creado para ${central.label}.`);
      }
      setAsking(null);
    } catch (failure) { setError(failed(failure, 'No se pudo crear.')); }
  };
  return <li className="meeting-task">
    <span><strong>{task.title}</strong>{task.who && <> · {task.who}</>}{task.due && <> · {new Date(`${task.due}T12:00:00`).toLocaleDateString('es-ES')}</>}</span>
    {done ? <small className="ok-note" role="status">{done}</small> : asking
      ? <span className="meeting-confirm" role="group" aria-label="Confirmar">
          <span>{asking === 'reminder' ? `¿Crear el recordatorio «${task.title}»${task.due ? ' para esa fecha' : ''}?` : `¿Encargar «${task.title}» a ${central?.label}?`}</span>
          <button type="button" className="button primary" onClick={() => void confirm()}>Confirmar</button>
          <button type="button" className="button" onClick={() => setAsking(null)}>Cancelar</button>
        </span>
      : <span className="meeting-actions">
          <button type="button" className="button" onClick={() => setAsking('reminder')}>Crear recordatorio</button>
          {central && <button type="button" className="button" onClick={() => setAsking('card')}>Encargar al bot central</button>}
        </span>}
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </li>;
}

/** Saving the meeting as a vault note: the user sees the whole note, picks the vault and folder, and
 * confirms. It never overwrites a note: a name already taken is refused by the vault. */
function SaveNote({ detail, vaults, onSaved }: { detail: MeetingDetail; vaults: Target['vaults']; onSaved: () => void }) {
  const [vault, setVault] = useState(vaults[0]?.id ?? '');
  const [folder, setFolder] = useState('Reuniones');
  const [title, setTitle] = useState(detail.draft?.title ?? '');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  if (!detail.draft) return null;
  if (detail.saved_note) return <p className="ok-note">Guardada en el vault: {detail.saved_note.note}</p>;
  if (!vaults.length) return <p className="muted">No hay ningún vault de Obsidian disponible para guardar la nota.</p>;
  const save = async () => {
    setError('');
    try {
      const made = await createVaultNote(vault, folder.trim(), title.trim(), detail.draft!.content);
      await markMeetingSaved(detail.id, vault, made.id);
      onSaved();
    } catch (failure) { setError(failed(failure, 'No se pudo guardar la nota.')); setAsking(false); }
  };
  return <div className="meeting-save">
    <details><summary>Ver la nota completa</summary><pre className="meeting-draft">{detail.draft.content}</pre></details>
    <div className="meeting-save-fields">
      <label className="field">Vault<ModernSelect value={vault} onChange={setVault} options={vaults.map(v => ({ value: v.id, label: v.name }))}/></label>
      <label className="field">Carpeta<input value={folder} onChange={event => setFolder(event.target.value)} maxLength={1000}/></label>
      <label className="field">Título<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200}/></label>
    </div>
    {asking ? <span className="meeting-confirm" role="group" aria-label="Confirmar">
        <span>¿Crear la nota «{title}» en {folder || 'la raíz'}?</span>
        <button type="button" className="button primary" onClick={() => void save()}>Crear la nota</button>
        <button type="button" className="button" onClick={() => setAsking(false)}>Cancelar</button>
      </span>
      : <button type="button" className="button primary" disabled={!vault || !title.trim()} onClick={() => setAsking(true)}>Guardar en el vault…</button>}
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </div>;
}

export function MeetingDetailPanel({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => getMeeting(id).then(setDetail).catch(failure => setError(failed(failure, 'No se pudo leer la reunión.')));
  if (!asked.current) {
    asked.current = true;
    void load();
    void Promise.all([getHermesCatalog(), getJobsSettings().catch(() => ({ central: '' }))]).then(([catalog, jobs]) => {
      const bot = catalog.profiles.find(p => p.name === jobs.central);
      setTarget({ vaults: (catalog.vaults ?? []).filter(v => v.available), central: bot ? { id: bot.id, label: bot.label } : null });
    }).catch(() => setTarget({ vaults: [], central: null }));
  }
  if (error) return <LoadError message={error}/>;
  if (!detail || !target) return <Loading label="Leyendo la reunión" lines={3}/>;
  const by = detail.summary_by === 'claude' ? 'Resumen de Claude' : detail.summary_by === 'local' ? 'Resumen del modelo local' : '';
  return <div className="meeting-detail">
    {detail.summary ? <section aria-label="Resumen">
      <h3>Resumen {by && <small className="muted">· {by}</small>}</h3>
      <p>{detail.summary.summary}</p>
      <h3>Decisiones</h3>
      {detail.summary.decisions.length ? <ul>{detail.summary.decisions.map((d, n) => <li key={n}>{d}</li>)}</ul> : <p className="muted">Ninguna.</p>}
      <h3>Tareas</h3>
      {detail.summary.tasks.length ? <ul className="meeting-tasks">{detail.summary.tasks.map((t, n) => <TaskRow key={n} task={t} meeting={detail.title} central={target.central}/>)}</ul> : <p className="muted">Ninguna.</p>}
    </section> : detail.work_error && <p className="fiscal-warning">{detail.work_error}</p>}
    <details><summary>Transcripción ({detail.transcript.length} {detail.transcript.length === 1 ? 'frase' : 'frases'})</summary>
      <ol className="meeting-transcript">{detail.transcript.map((s, n) => <li key={n}><span className="muted">{Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2, '0')}</span> <strong>{s.speaker}:</strong> {s.text}</li>)}</ol>
    </details>
    <SaveNote detail={detail} vaults={target.vaults} onSaved={() => { void load(); onChanged(); }}/>
  </div>;
}
