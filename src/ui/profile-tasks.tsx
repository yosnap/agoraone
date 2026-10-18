import { useState, type FormEvent } from 'react';
import { changeCard, changeJob, createCard, createJob, getJob, type JobDetail } from '../api/client';
import type { ProfileActivity } from '../../shared/hermes-activity';
import { statusLabel, when } from '../data/activity-format';

// Managing a profile's scheduled tasks and kanban cards (user's decision, 18/10/2026). Every change is an
// explicit button press and goes through Hermes' own functions; deleting and archiving ask first.
type Busy = { busy: string; run: (key: string, action: () => Promise<unknown>) => Promise<boolean> };

function useAction(onChanged: () => void): Busy & { error: string; done: string; say: (text: string) => void } {
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
  async function send(event: FormEvent) { event.preventDefault(); setSending(true); if (!(await submit(job))) setSending(false); }
  return <form className="task-form" onSubmit={send} aria-label={label}>
    <label>Nombre<input autoFocus value={job.name} maxLength={100} onChange={event => setJob({ ...job, name: event.target.value })} required/></label>
    {once ? <small>Es una tarea de una sola vez: su momento no se cambia aquí.</small> : <>
      <label>Cuándo<input value={job.schedule} maxLength={120} placeholder="every 2h · 0 9 * * 1-5 · in 30m" onChange={event => setJob({ ...job, schedule: event.target.value })} required/></label>
      <small>Repetida cada cierto tiempo («every 2h»; «30m» también se repite cada 30 minutos), con una expresión cron («0 9 * * 1-5», días laborables a las 9) o una sola vez dentro de un rato («in 30m»).</small>
    </>}
    <label>Qué debe hacer el perfil<textarea value={job.prompt} maxLength={4000} onChange={event => setJob({ ...job, prompt: event.target.value })} required/></label>
    {hidden > 0 && <small>{hidden === 1 ? 'Una línea que parece una clave se muestra' : `${hidden} líneas que parecen claves se muestran`} como «[línea oculta N]» y se conserva al guardar.</small>}
    <p className="approval-warning">Hermes la ejecutará en su horario con las herramientas y permisos del perfil, sin pedirte confirmación, como cualquier tarea programada. El resultado se guarda en Hermes; no se envía a ningún chat.</p>
    <div><button type="submit" className="primary" disabled={sending}>{sending ? 'Guardando…' : label}</button><button type="button" disabled={sending} onClick={onCancel}>Cancelar</button></div>
  </form>;
}

export function JobManager({ profileId, jobs, gateway, onChanged }: { profileId: string; jobs: ProfileActivity['jobs']; gateway: string; onChanged: () => void }) {
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
        {job.id && <div className="task-actions">
          {job.enabled ? <button type="button" disabled={!!action.busy} onClick={() => action.run(`pause:${job.id}`, () => changeJob(profileId, job.id!, { action: 'pause' }))}>Pausar</button>
            : <button type="button" disabled={!!action.busy} onClick={() => action.run(`resume:${job.id}`, () => changeJob(profileId, job.id!, { action: 'resume' }))}>Reanudar</button>}
          <button type="button" disabled={!!action.busy} onClick={async () => { if (await action.run(`run:${job.id}`, () => changeJob(profileId, job.id!, { action: 'run' })))
            action.say(gateway === 'running' ? `«${job.name}» queda marcada: el gateway de Hermes la ejecutará en su próximo ciclo si atiende las tareas de este perfil.` : `«${job.name}» queda marcada para ejecutarse, pero el gateway de Hermes no está en marcha: se ejecutará cuando arranque.`); }}>{action.busy === `run:${job.id}` ? 'Marcando…' : 'Ejecutar ahora'}</button>
          <button type="button" disabled={!!action.busy} onClick={() => edit(job.id!)}>Editar</button>
          {confirm === job.id ? <><button type="button" className="danger" disabled={!!action.busy} onClick={async () => { await action.run(`remove:${job.id}`, () => changeJob(profileId, job.id!, { action: 'remove' })); setConfirm(null); }}>Eliminar definitivamente</button>
            <button type="button" onClick={() => setConfirm(null)}>No</button></>
            : <button type="button" disabled={!!action.busy} onClick={() => setConfirm(job.id)}>Eliminar</button>}
        </div>}
      </li>)}</ul>}
    {action.error && <p role="alert" className="error">{action.error}</p>}
    {action.done && <p role="status" className="task-done">{action.done}</p>}
    {form === null ? <button type="button" className="task-new" onClick={() => setForm('new')}>+ Nueva tarea programada</button>
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
  const [note, setNote] = useState<{ id: string; kind: 'comment' | 'block'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!board) return <p>Tablero kanban no disponible.</p>;
  return <div className="task-manager">
    {board.byStatus.length ? <p>{board.byStatus.map(item => `${statusLabel(item.status)}: ${item.count}`).join(' · ')}</p> : <p>Sin tareas asignadas a este perfil en el tablero.</p>}
    {!!board.open.length && <ul>{board.open.map((task, i) => <li key={task.id ?? i}>{task.title} · {statusLabel(task.status)}
      {task.id && <div className="task-actions">
        <button type="button" disabled={!!action.busy} onClick={async () => { if (await action.run(`done:${task.id}`, () => changeCard(profileId, task.id!, { action: 'complete' }))) action.say(`Tarjeta «${task.title}» completada.`); }}>Completar</button>
        {task.status === 'blocked' ? <button type="button" disabled={!!action.busy} onClick={() => action.run(`unblock:${task.id}`, () => changeCard(profileId, task.id!, { action: 'unblock' }))}>Desbloquear</button>
          : <button type="button" disabled={!!action.busy} onClick={() => setNote({ id: task.id!, kind: 'block', text: '' })}>Bloquear</button>}
        <button type="button" disabled={!!action.busy} onClick={() => setNote({ id: task.id!, kind: 'comment', text: '' })}>Comentar</button>
        {confirm === task.id ? <>{task.status === 'running' && <small className="approval-warning">Un agente está trabajando en ella: archivarla lo detendrá.</small>}<button type="button" className="danger" disabled={!!action.busy} onClick={async () => { if (await action.run(`archive:${task.id}`, () => changeCard(profileId, task.id!, { action: 'archive' }))) action.say(`Tarjeta «${task.title}» archivada.`); setConfirm(null); }}>Archivar definitivamente</button>
          <button type="button" onClick={() => setConfirm(null)}>No</button></>
          : <button type="button" disabled={!!action.busy} onClick={() => setConfirm(task.id)}>Archivar</button>}
      </div>}
      {note?.id === task.id && <form className="task-form" onSubmit={async event => { event.preventDefault();
        if (await action.run(`${note.kind}:${task.id}`, () => note.kind === 'block' ? changeCard(profileId, task.id!, { action: 'block', reason: note.text || undefined }) : changeCard(profileId, task.id!, { action: 'comment', body: note.text }))) { setNote(null); action.say(note.kind === 'block' ? `Tarjeta «${task.title}» bloqueada.` : 'Comentario añadido.'); } }}>
        <label>{note.kind === 'block' ? 'Motivo del bloqueo (opcional)' : 'Comentario'}<textarea autoFocus value={note.text} maxLength={note.kind === 'block' ? 500 : 4000} required={note.kind === 'comment'} onChange={event => setNote({ ...note, text: event.target.value })}/></label>
        <div><button type="submit" className="primary" disabled={!!action.busy}>{note.kind === 'block' ? 'Bloquear' : 'Añadir comentario'}</button><button type="button" onClick={() => setNote(null)}>Cancelar</button></div>
      </form>}
    </li>)}</ul>}
    {action.error && <p role="alert" className="error">{action.error}</p>}
    {action.done && <p role="status" className="task-done">{action.done}</p>}
    {!adding ? <button type="button" className="task-new" onClick={() => setAdding(true)}>+ Nueva tarjeta para este perfil</button>
      : <form className="task-form" aria-label="Nueva tarjeta" onSubmit={async event => { event.preventDefault();
        if (await action.run('create', () => createCard(profileId, { title: card.title, body: card.body || undefined }))) { setAdding(false); action.say(`Tarjeta «${card.title}» creada.`); setCard({ title: '', body: '' }); } }}>
        <label>Título<input autoFocus value={card.title} maxLength={200} required onChange={event => setCard({ ...card, title: event.target.value })}/></label>
        <label>Detalle (opcional)<textarea value={card.body} maxLength={4000} onChange={event => setCard({ ...card, body: event.target.value })}/></label>
        <p className="approval-warning">Queda asignada a este perfil. Si el despachador de kanban de Hermes está activo, el perfil trabajará en ella por su cuenta, con sus herramientas y sin pedirte confirmación.</p>
        <div><button type="submit" className="primary" disabled={!!action.busy}>Crear tarjeta</button><button type="button" onClick={() => setAdding(false)}>Cancelar</button></div>
      </form>}
  </div>;
}
