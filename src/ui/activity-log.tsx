import { mcpServerKey, type ActivityEvent, type HermesActivity } from '../../shared/hermes-activity';
import type { HermesCatalog } from '../../shared/hermes-catalog';
import { ago, platformName, platformStates, sourceLabel, statusLabel } from '../data/activity-format';
import { Loading, LoadError } from './load-state';

function describe(event: ActivityEvent, mcpName: (key: string) => string) {
  if (event.kind === 'session') return `Sesión desde ${sourceLabel(event.source)}`;
  if (event.kind === 'job') return `Tarea programada «${event.name}» · ${statusLabel(event.status)}`;
  if (event.kind === 'mcp') return `MCP ${mcpName(event.server)} · ${event.calls === 1 ? '1 llamada' : `${event.calls} llamadas`}`;
  return `${platformName(event.name)} · ${platformStates[event.state]}`;
}

// City-wide log of what Hermes recorded in the last 24 h. Real records only: times, origins and names.
export function ActivityLog({ activity, catalog, error, onSelect, onClose, onRetry }: {
  activity: HermesActivity | null; catalog: HermesCatalog | null; error: boolean; onSelect: (id: string) => void; onClose: () => void; onRetry?: () => void;
}) {
  const events = Object.entries(activity?.profiles ?? {}).flatMap(([profileId, data]) => {
    // A profile missing from the catalog (not loaded yet, or just removed) still shows its events, without a link.
    const profile = catalog?.profiles.find(item => item.id === profileId);
    const mcpName = (key: string) => profile?.mcp?.find(server => mcpServerKey(server.name) === key)?.name ?? key;
    // Hermes can record two events of the same kind in the same millisecond (parallel subagents), so the position disambiguates.
    return data.events.map((event, index) => ({ event, profileId, profile, text: describe(event, mcpName),
      key: `${profileId}|${index}|${event.kind}|${event.at}|${event.kind === 'mcp' ? event.server : event.kind === 'session' ? event.source : event.name}` }));
  }).sort((a, b) => b.event.at.localeCompare(a.event.at)).slice(0, 60);
  const clock = (iso: string) => new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
  return <aside className="detail-panel activity-log" aria-label="Registro de actividad de Hermes">
    <button className="close" aria-label="Cerrar registro" onClick={onClose}>×</button>
    <div className="eyebrow">REGISTRO · ÚLTIMAS 24 H</div>
    <h2>Actividad</h2>
    <p className="description">Lo que Hermes ha registrado: sesiones por origen, tareas programadas, llamadas a MCP agrupadas por hora y cambios de conexión. Sin contenido de mensajes ni títulos de conversaciones.</p>
    {error && <LoadError message="No se pudo leer la actividad de Hermes." onRetry={onRetry}/>}
    {!activity && !error && <Loading label="Leyendo registros de Hermes…" lines={5}/>}
    {activity && !events.length && <p>Hermes no ha registrado actividad en las últimas 24 horas.</p>}
    <ol className="activity-events">{events.map(({ event, profileId, profile, text, key }) => <li key={key}>
      <time dateTime={event.at} title={new Date(event.at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}>{clock(event.at)}</time>
      <span>{profile ? <button className="catalog-link" onClick={() => onSelect(profile.id)}><span className="place-dot" style={{ background: profile.color }}/>{profile.label}</button> : <strong>Perfil {profileId.slice(-6)}</strong>}{text}<small>{ago(event.at)}</small></span>
    </li>)}</ol>
    {activity && <small>Leído {new Date(activity.readAt).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}; se actualiza cada 15 s.</small>}
  </aside>;
}
