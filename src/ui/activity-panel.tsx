import type { HermesActivity, ProfileActivity } from '../../shared/hermes-activity';
import { ago, platformName, platformStates, recentlyActive, sourceLabel, statusLabel, when } from '../data/activity-format';

export function JobList({ jobs }: { jobs: ProfileActivity['jobs'] }) {
  if (!jobs) return <p>Sin archivo de tareas programadas en este perfil.</p>;
  if (!jobs.length) return <p>No hay tareas programadas.</p>;
  return <ul>{jobs.map((job, i) => <li key={i}><strong>{job.name}</strong> · {job.enabled ? job.schedule || 'sin horario' : 'deshabilitada'}<br/>
    <small>Último resultado: {statusLabel(job.lastStatus)}{job.lastRunAt ? ` (${when(job.lastRunAt)})` : ''} · próxima: {job.enabled ? when(job.nextRunAt) : 'ninguna'}</small></li>)}</ul>;
}

export function BoardList({ board }: { board: ProfileActivity['board'] }) {
  if (!board) return <p>Tablero kanban no disponible.</p>;
  if (!board.byStatus.length) return <p>Sin tareas asignadas a este perfil en el tablero.</p>;
  return <>
    <p>{board.byStatus.map(item => `${statusLabel(item.status)}: ${item.count}`).join(' · ')}</p>
    {!!board.open.length && <ul>{board.open.map((task, i) => <li key={i}>{task.title} · {statusLabel(task.status)}</li>)}</ul>}
  </>;
}

// Real records only, each with its source; nothing here starts Hermes or reads conversations.
export function ActivitySection({ activity, data, error }: { activity: ProfileActivity | undefined; data: HermesActivity | null; error: boolean }) {
  return <section className="activity-section" aria-label="Actividad real registrada por Hermes">
    <h3>Actividad real</h3>
    {error && <p className="error" role="alert">No se pudo leer la actividad de Hermes. No se muestran datos anteriores.</p>}
    {!data && !error && <p role="status">Leyendo registros de Hermes…</p>}
    {data && !activity && <p>Hermes no tiene registros de actividad para este perfil.</p>}
    {data && activity && <>
      <small>Fuente: estado del gateway, sesiones (solo fechas y origen), tareas programadas y kanban de Hermes. Leído {new Date(data.readAt).toLocaleTimeString('es-ES')}; se actualiza cada 15 s. Sin contenido de mensajes ni títulos de conversaciones.</small>
      <h4>Conexiones del gateway</h4>
      {activity.platforms.length ? <ul>{activity.platforms.map(link => <li key={link.name}><span className={`link-dot ${link.state}`} aria-hidden/>{platformName(link.name)} · {platformStates[link.state]}</li>)}</ul>
        : <p>El gateway no publica conexiones para este perfil.</p>}
      <h4>Actividad registrada</h4>
      <p>{recentlyActive(activity) ? <strong>Actividad registrada {ago(activity.lastActivityAt)}</strong> : <>Última actividad: {ago(activity.lastActivityAt)}</>}{activity.lastActivityAt && ` (${when(activity.lastActivityAt)})`}</p>
      <p>{activity.recent.length ? `Últimas 24 h: ${activity.recent.map(item => `${item.sessions} ${item.sessions === 1 ? 'sesión' : 'sesiones'} desde ${sourceLabel(item.source)}`).join(', ')}.` : 'Sin sesiones con actividad en las últimas 24 h.'}</p>
      <h4>Tareas programadas</h4>
      <JobList jobs={activity.jobs}/>
      <h4>Tablero kanban</h4>
      <BoardList board={activity.board}/>
    </>}
  </section>;
}
