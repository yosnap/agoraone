import { useState, type FormEvent, type ReactNode } from 'react';
import { changeCard, changeJob, createCard, createJob, getJob, type JobDetail } from '../api/client';
import type { ProfileActivity, ScheduledJob } from '../../shared/hermes-activity';
import { statusLabel, when } from '../data/activity-format';
import { MarkdownField } from './markdown-field';
import { ActionButton } from './action-button';

// Managing a profile's scheduled tasks and kanban cards (user's decision, 18/10/2026). Every change is an
// explicit button press and goes through Hermes' own functions; deleting and archiving ask first.
type Busy = { busy: string; run: (key: string, action: () => Promise<unknown>) => Promise<boolean> };

export type ActionState = Busy & { error: string; done: string; say: (text: string) => void };

/** One busy state and one place for the result messages, shared by a list's items. */
export function useAction(onChanged: () => void): ActionState {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key); setError(''); setDone('');
    try { await action(); onChanged(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar.'); return false; }
    finally { setBusy(''); }
  }
  return { busy, run, error, done, say: setDone };
}

function JobForm({ initial, hidden = 0, once = false, submit, onCancel, label }: {
  initial: { name: string; schedule: string; prompt: string }; hidden?: number; once?: boolean; label: string;
  submit: (job: { name: string; schedule: string; prompt: string }) => Promise<boolean>; onCancel: () => void;
}) {
  const [job, setJob] = useState(initial);
  const [sending, setSending] = useState(false);
  const [missing, setMissing] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!job.prompt.trim()) return setMissing(true);
    setMissing(false); setSending(true); if (!(await submit(job))) setSending(false);
  }
  return <form className="task-form" onSubmit={send} aria-label={label}>
    <label>Nombre<input autoFocus value={job.name} maxLength={100} onChange={event => setJob({ ...job, name: event.target.value })} required/></label>
    {once ? <small>Es una tarea de una sola vez: su momento no se cambia aquí.</small> : <>
      <label>Cuándo<input value={job.schedule} maxLength={120} placeholder="every 2h · 0 9 * * 1-5 · in 30m" onChange={event => setJob({ ...job, schedule: event.target.value })} required/></label>
      <small>Repetida cada cierto tiempo («every 2h»; «30m» también se repite cada 30 minutos), con una expresión cron («0 9 * * 1-5», días laborables a las 9) o una sola vez dentro de un rato («in 30m»).</small>
    </>}
    <div className="task-field"><span>Qué debe hacer el perfil</span><MarkdownField label="Qué debe hacer el perfil" value={job.prompt} onChange={prompt => setJob({ ...job, prompt })} minHeight={120} disabled={sending}/></div>
    {missing && <p role="alert" className="error">Escribe qué debe hacer el perfil.</p>}
    {hidden > 0 && <small>{hidden === 1 ? 'Una línea que parece una clave se muestra' : `${hidden} líneas que parecen claves se muestran`} como «[línea oculta N]» y se conserva al guardar.</small>}
    <p className="approval-warning">Hermes la ejecutará en su horario con las herramientas y permisos del perfil, sin pedirte confirmación, como cualquier tarea programada. El resultado se guarda en Hermes; no se envía a ningún chat.</p>
    <div><button type="submit" className="primary" disabled={sending}>{sending ? 'Guardando…' : label}</button><ActionButton icon="close" label="Cancelar" disabled={sending} onClick={onCancel}/></div>
  </form>;
}

/** A profile's scheduled tasks with their actions; `extra` adds a detail under each one (Trabajos shows its runs). */
export function JobManager<J extends ScheduledJob>({ profileId, jobs, gateway, onChanged, extra }: {
  profileId: string; jobs: J[] | null; gateway: string; onChanged: () => void; extra?: (job: J) => ReactNode;
}) {
  const action = useAction(onChanged);
  const [form, setForm] = useState<'new' | JobDetail | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  async function edit(jobId: string) {
    await action.run(`edit:${jobId}`, async () => setForm(await getJob(profileId, jobId)));
  }
  return <div className="task-manager">
    {!jobs ? <p>Este perfil aún no tiene archivo de tareas programadas.</p> : !jobs.length ? <p>No hay tareas programadas.</p>
      : <ul>{jobs.map((job, i) => <li key={job.id ?? i}><strong>{job.name}</strong> · {job.enabled ? job.schedule || 'sin horario' : 'en pausa'}<br/>
        <small>Último resultado: {statusLabel(job.lastStatus)}{job.lastRunAt ? ` (${when(job.lastRunAt)})` : ''} · próxima: {job.enabled ? when(job.nextRunAt) : 'ninguna'}</small>
        {extra?.(job)}
        {job.id && <div className="task-actions">
          {job.enabled ? <ActionButton icon="pause" label="Pausar" small disabled={!!action.busy} onClick={() => action.run(`pause:${job.id}`, () => changeJob(profileId, job.id!, { action: 'pause' }))}/>
            : <ActionButton icon="play" label="Reanudar" small disabled={!!action.busy} onClick={() => action.run(`resume:${job.id}`, () => changeJob(profileId, job.id!, { action: 'resume' }))}/>}
          <button type="button" className="act-run" disabled={!!action.busy} onClick={async () => { if (await action.run(`run:${job.id}`, () => changeJob(profileId, job.id!, { action: 'run' })))
            action.say(gateway === 'running' ? `«${job.name}» queda marcada: el gateway de Hermes la ejecutará en su próximo ciclo si atiende las tareas de este perfil.` : gateway === 'unknown' ? `«${job.name}» queda marcada: se ejecutará cuando el gateway de Hermes la recoja.` : `«${job.name}» queda marcada para ejecutarse, pero el gateway de Hermes no está en marcha: se ejecutará cuando arranque.`); }}>{action.busy === `run:${job.id}` ? 'Marcando…' : 'Ejecutar ahora'}</button>
          <ActionButton icon="edit" label="Editar" small disabled={!!action.busy} onClick={() => edit(job.id!)}/>
          {confirm === job.id ? <><ActionButton icon="trash" label="Eliminar definitivamente" tone="danger" disabled={!!action.busy} onClick={async () => { await action.run(`remove:${job.id}`, () => changeJob(profileId, job.id!, { action: 'remove' })); setConfirm(null); }}/>
            <ActionButton icon="close" label="No" onClick={() => setConfirm(null)}/></>
            : <ActionButton icon="trash" label="Eliminar" tone="danger" small disabled={!!action.busy} onClick={() => setConfirm(job.id)}/>}
        </div>}
      </li>)}</ul>}
    {action.error && <p role="alert" className="error">{action.error}</p>}
    {action.done && <p role="status" className="task-done">{action.done}</p>}
    {form === null ? <ActionButton icon="plus" label="Nueva tarea programada" className="task-new" onClick={() => setForm('new')}/>
      : <JobForm key={form === 'new' ? 'new' : form.id} label={form === 'new' ? 'Crear tarea' : 'Guardar cambios'} hidden={form === 'new' ? 0 : form.hidden} once={form !== 'new' && form.once}
        initial={form === 'new' ? { name: '', schedule: '', prompt: '' } : { name: form.name, schedule: form.schedule, prompt: form.prompt }}
        onCancel={() => setForm(null)}
        submit={job => action.run('save', async () => {
          if (form === 'new') await createJob(profileId, job);
          else {
            // Only what the user changed: resending an unchanged schedule would make Hermes recompute and re-enable it.
            const change = { name: job.name !== form.name ? job.name : undefined, schedule: !form.once && job.schedule !== form.schedule ? job.schedule : undefined,
              ...(job.prompt !== form.prompt ? { prompt: job.prompt, revision: form.revision } : {}) };
            await changeJob(profileId, form.id, { action: 'update', ...change });
          }
          setForm(null); action.say(form === 'new' ? `Tarea «${job.name}» creada.` : `Tarea «${job.name}» actualizada.`);
        })}/>}
  </div>;
}

export function BoardManager({ profileId, board, onChanged }: { profileId: string; board: ProfileActivity['board']; onChanged: () => void }) {
  const action = useAction(onChanged);
  const [adding, setAdding] = useState(false);
  const [card, setCard] = useState({ title: '', body: '' });
  if (!board) return <p>Tablero kanban no disponible.</p>;
  return <div className="task-manager">
    {board.byStatus.length ? <p>{board.byStatus.map(item => `${statusLabel(item.status)}: ${item.count}`).join(' · ')}</p> : <p>Sin tareas asignadas a este perfil en el tablero.</p>}
    {!!board.open.length && <ul>{board.open.map((task, i) => <li key={task.id ?? i}>{task.title} · {statusLabel(task.status)}
      {task.id && <CardControls profileId={profileId} card={{ id: task.id, title: task.title, status: task.status }} action={action}/>}
    </li>)}</ul>}
    {action.error && <p role="alert" className="error">{action.error}</p>}
    {action.done && <p role="status" className="task-done">{action.done}</p>}
    {!adding ? <ActionButton icon="plus" label="Nueva tarjeta para este perfil" className="task-new" onClick={() => setAdding(true)}/>
      : <form className="task-form" aria-label="Nueva tarjeta" onSubmit={async event => { event.preventDefault();
        if (await action.run('create', () => createCard(profileId, { title: card.title, body: card.body || undefined }))) { setAdding(false); action.say(`Tarjeta «${card.title}» creada.`); setCard({ title: '', body: '' }); } }}>
        <label>Título<input autoFocus value={card.title} maxLength={200} required onChange={event => setCard({ ...card, title: event.target.value })}/></label>
        <div className="task-field"><span>Detalle (opcional)</span><MarkdownField label="Detalle (opcional)" value={card.body} onChange={body => setCard({ ...card, body })} minHeight={90}/></div>
        <p className="approval-warning">Queda asignada a este perfil. Si el despachador de kanban de Hermes está activo, el perfil trabajará en ella por su cuenta, con sus herramientas y sin pedirte confirmación.</p>
        <div><ActionButton icon="plus" label="Crear tarjeta" tone="primary" type="submit" disabled={!!action.busy}/><ActionButton icon="close" label="Cancelar" onClick={() => setAdding(false)}/></div>
      </form>}
  </div>;
}

/** The actions on one kanban card (complete, block or unblock, comment, archive), each through Hermes' own functions.
 * The list owns `action`, so its messages stay when a completed or archived card leaves the list. */
export function CardControls({ profileId, card, action }: { profileId: string; card: { id: string; title: string; status: string }; action: ActionState }) {
  const [note, setNote] = useState<{ id: string; kind: 'comment' | 'block'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return <>
      <div className="task-actions">
        <ActionButton icon="check" label="Completar" disabled={!!action.busy} onClick={async () => { if (await action.run(`done:${card.id}`, () => changeCard(profileId, card.id, { action: 'complete' }))) action.say(`Tarjeta «${card.title}» completada.`); }}/>
        {card.status === 'blocked' ? <button type="button" disabled={!!action.busy} onClick={() => action.run(`unblock:${card.id}`, () => changeCard(profileId, card.id, { action: 'unblock' }))}>Desbloquear</button>
          : <button type="button" disabled={!!action.busy} onClick={() => setNote({ id: card.id, kind: 'block', text: '' })}>Bloquear</button>}
        <ActionButton icon="edit" label="Comentar" disabled={!!action.busy} onClick={() => setNote({ id: card.id, kind: 'comment', text: '' })}/>
        {confirm === card.id ? <>{card.status === 'running' && <small className="approval-warning">Un agente está trabajando en ella: archivarla lo detendrá.</small>}<ActionButton icon="archive" label="Archivar definitivamente" tone="danger" disabled={!!action.busy} onClick={async () => { if (await action.run(`archive:${card.id}`, () => changeCard(profileId, card.id, { action: 'archive' }))) action.say(`Tarjeta «${card.title}» archivada.`); setConfirm(null); }}/>
          <ActionButton icon="close" label="No" onClick={() => setConfirm(null)}/></>
          : <ActionButton icon="archive" label="Archivar" disabled={!!action.busy} onClick={() => setConfirm(card.id)}/>}
      </div>
      {note?.id === card.id && <form className="task-form" onSubmit={async event => { event.preventDefault();
        if (note.kind === 'comment' && !note.text.trim()) return;
        if (await action.run(`${note.kind}:${card.id}`, () => note.kind === 'block' ? changeCard(profileId, card.id, { action: 'block', reason: note.text || undefined }) : changeCard(profileId, card.id, { action: 'comment', body: note.text }))) { setNote(null); action.say(note.kind === 'block' ? `Tarjeta «${card.title}» bloqueada.` : 'Comentario añadido.'); } }}>
        {note.kind === 'block' ? <label>Motivo del bloqueo (opcional)<textarea autoFocus value={note.text} maxLength={500} onChange={event => setNote({ ...note, text: event.target.value })}/></label>
          : <div className="task-field"><span>Comentario</span><MarkdownField label="Comentario" value={note.text} onChange={text => setNote({ ...note, text })} minHeight={90} autoFocus/></div>}
        <div><button type="submit" className="primary" disabled={!!action.busy}>{note.kind === 'block' ? 'Bloquear' : 'Añadir comentario'}</button><ActionButton icon="close" label="Cancelar" onClick={() => setNote(null)}/></div>
      </form>}
  </>;
}
