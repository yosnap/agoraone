import { mcpServerKey, type HermesActivity, type ProfileActivity } from '../../shared/hermes-activity';
import { BoardManager, JobManager } from './profile-tasks';
import { ago, platformName, platformStates, recentlyActive, sourceLabel, statusLabel, usageLine, when } from '../data/activity-format';
import { Loading, LoadError } from './load-state';

export function JobList({ jobs }: { jobs: ProfileActivity['jobs'] }) {
  if (!jobs) return <p>Sin archivo de tareas programadas en este perfil.</p>;
  if (!jobs.length) return <p>No hay tareas programadas.</p>;
  return <ul>{jobs.map((job, i) => <li key={i}><strong>{job.name}</strong> · {job.enabled ? job.schedule || 'sin horario' : 'deshabilitada'}<br/>
    <small>Último resultado: {statusLabel(job.lastStatus)}{job.lastRunAt ? ` (${when(job.lastRunAt)})` : ''} · próxima: {job.enabled ? when(job.nextRunAt) : 'ninguna'}</small></li>)}</ul>;
}

export function UsageList({ usage, declared = [] }: { usage: ProfileActivity['usage']; declared?: string[] }) {
  // Hermes stores a sanitised server key; show the name as written in config.yaml when it matches.
  const label = (key: string) => declared.find(name => mcpServerKey(name) === key);
  if (!usage) return <p>Sin registro de herramientas en este perfil.</p>;
  if (!usage.tools.length && !usage.mcp.length) return <p>Sin llamadas con nombre registrado. Las sesiones antiguas de terminal no siempre guardan el nombre de la herramienta.</p>;
  return <>
    {!!usage.mcp.length && <ul>{usage.mcp.map(server => <li key={server.name}><strong>MCP · {label(server.name) ?? server.name}</strong>{!label(server.name) && ' (no declarado en config.yaml)'} · {usageLine(server, usage.windowDays)}
      <br/><small>{server.tools.filter(tool => tool.calls).slice(0, 5).map(tool => `${tool.name} (${tool.calls})`).join(', ') || `sin llamadas en ${usage.windowDays} días`}</small></li>)}</ul>}
    {!!usage.tools.length && <p>Herramientas de Hermes en {usage.windowDays} días: {usage.tools.filter(tool => tool.calls).map(tool => `${tool.name} (${tool.calls})`).join(', ') || 'ninguna'}.</p>}
  </>;
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
export function ActivitySection({ activity, data, error, declared, profileId, onChanged }: { activity: ProfileActivity | undefined; data: HermesActivity | null; error: boolean; declared?: string[]; profileId?: string; onChanged?: () => void }) {
  return <section className="activity-section" aria-label="Actividad real registrada por Hermes">
    <h3>Actividad real</h3>
    {error && <LoadError message="No se pudo leer la actividad de Hermes. No se muestran datos anteriores." onRetry={onChanged}/>}
    {!data && !error && <Loading label="Leyendo registros de Hermes…"/>}
    {data && !activity && <p>Hermes no tiene registros de actividad para este perfil.</p>}
    {data && activity && <>
      <small>Fuente: estado del gateway, sesiones (solo fechas y origen), nombres de herramientas llamadas, tareas programadas y kanban de Hermes. Leído {new Date(data.readAt).toLocaleTimeString('es-ES')}; se actualiza cada 15 s. Sin contenido de mensajes ni títulos de conversaciones. Las tareas programadas y las tarjetas del kanban se pueden gestionar aquí.</small>
      <h4>Conexiones del gateway</h4>
      {activity.platforms.length ? <ul>{activity.platforms.map(link => <li key={link.name}><span className={`link-dot ${link.state}`} aria-hidden/>{platformName(link.name)} · {platformStates[link.state]}</li>)}</ul>
        : <p>El gateway no publica conexiones para este perfil.</p>}
      <h4>Actividad registrada</h4>
      <p>{recentlyActive(activity) ? <strong>Actividad registrada {ago(activity.lastActivityAt)}</strong> : <>Última actividad: {ago(activity.lastActivityAt)}</>}{activity.lastActivityAt && ` (${when(activity.lastActivityAt)})`}</p>
      <p>{activity.recent.length ? `Últimas 24 h: ${activity.recent.map(item => `${item.sessions} ${item.sessions === 1 ? 'sesión' : 'sesiones'} desde ${sourceLabel(item.source)}`).join(', ')}.` : 'Sin sesiones con actividad en las últimas 24 h.'}</p>
      <h4>Herramientas usadas</h4>
      <UsageList usage={activity.usage} declared={declared}/>
      <h4>Tareas programadas</h4>
      {profileId && onChanged ? <JobManager profileId={profileId} jobs={activity.jobs} gateway={data.gateway.state} onChanged={onChanged}/> : <JobList jobs={activity.jobs}/>}
      <h4>Tablero kanban</h4>
      {profileId && onChanged ? <BoardManager profileId={profileId} board={activity.board} onChanged={onChanged}/> : <BoardList board={activity.board}/>}
    </>}
  </section>;
}
