import type { ActivityEvent } from '../../shared/hermes-activity';
import type { WatsonEvent } from '../api/core';

/** How the agents' records read in Spanish (the «Agentes» section and the brain's block): times, what each
 * entry means and how it ended. Pure, so it is tested apart from the screen. */

export const ago = (stamp: string | null, now = Date.now()) => {
  if (!stamp) return '';
  const minutes = Math.max(0, Math.round((now - new Date(stamp).getTime()) / 60000));
  return minutes < 1 ? 'ahora mismo' : minutes < 60 ? `hace ${minutes} min` : minutes < 1440 ? `hace ${Math.round(minutes / 60)} h` : `hace ${Math.round(minutes / 1440)} d`;
};
export const until = (stamp: string, now = Date.now()) => {
  const minutes = Math.round((new Date(stamp).getTime() - now) / 60000);
  if (minutes <= 0) return 'ahora';
  return minutes < 60 ? `en ${minutes} min` : minutes < 1440 ? `en ${Math.round(minutes / 60)} h` : new Date(stamp).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' });
};
export const RUNNING = new Set(['claimed', 'running', 'review']);
export const BLOCKED = new Set(['blocked', 'failed', 'crashed', 'timed_out']);
export const sourceLabel: Record<string, string> = { telegram: 'Telegram', desktop: 'Desktop', cron: 'tarea programada', cli: 'terminal', api: 'API', acp: 'editor', subagent: 'subagente' };

export type Outcome = 'hecho' | 'falló' | 'rechazado' | 'deshecho' | null;
export type Line = { at: string; who: string; text: string; outcome: Outcome; key: string };

export function describe(event: ActivityEvent, who: string, discreet = false): Line {
  const key = `${who}|${event.at}|${event.kind}`;
  if (event.kind === 'job') {
    const failed = event.status !== null && /fail|error|crash|timeout/i.test(event.status);
    return { key: `${key}|${event.name}`, at: event.at, who, text: discreet ? 'una tarea programada' : `tarea «${event.name}»`, outcome: event.status === null ? null : failed ? 'falló' : 'hecho' };
  }
  if (event.kind === 'session') return { key: `${key}|${event.source}`, at: event.at, who, text: `conversación por ${sourceLabel[event.source] ?? event.source}`, outcome: null };
  if (event.kind === 'mcp') return { key: `${key}|${event.server}`, at: event.at, who, text: `${event.calls} ${event.calls === 1 ? 'llamada' : 'llamadas'} a ${event.server}`, outcome: null };
  return { key: `${key}|${event.name}`, at: event.at, who, text: `${event.name}: conexión ${event.state === 'disconnected' ? 'caída' : event.state}`, outcome: 'falló' };
}

const watsonLabels: Record<string, string> = {
  buscar: 'buscó en tus notas', leer: 'leyó una nota', bandeja: 'miró la Bandeja', clientes: 'consultó tus clientes', projects: 'consultó proyectos',
  agenda: 'miró la agenda', day: 'repasó tu día', consultar_reuniones: 'buscó reuniones', meetings: 'buscó reuniones', leer_reunion: 'leyó una reunión', meeting: 'leyó una reunión', revisar_vault: 'revisó el vault',
  consultar_trabajos: 'consultó los trabajos', proponer_nota: 'propuso una nota', proponer_evento: 'propuso un evento', proponer_presupuesto: 'propuso un presupuesto',
  proponer_limpieza: 'propuso limpiar correo', proponer_reorganizacion: 'propuso ordenar el vault', proponer_regla: 'propuso una regla de correo',
  proponer_issue: 'propuso una issue', crear_regla: 'creaste una regla de correo', 'mail.send': 'enviaste un correo',
};
const outcomes: Record<WatsonEvent['outcome'], Outcome> = { done: 'hecho', denied: 'rechazado', failed: 'falló', undone: 'deshecho' };
// Looking things up is not a decision: only what changes something or proposes it says how it ended.
const decided = (action: string) => action.startsWith('proponer_') || action === 'crear_regla' || action === 'mail.send';

export function describeWatson(event: WatsonEvent, assistant: string): Line {
  const who = event.actor === 'user' ? 'Tú' : assistant;
  return { key: `w|${event.id}`, at: event.at, who, text: watsonLabels[event.action] ?? event.action.replace(/[_.]/g, ' '),
    outcome: decided(event.action) || event.outcome !== 'done' ? outcomes[event.outcome] : null };
}

export const outcomeLabel = (outcome: Outcome) => outcome === 'hecho' ? 'Hecho' : outcome === 'falló' ? 'Falló' : outcome === 'rechazado' ? 'Rechazado' : outcome === 'deshecho' ? 'Deshecho' : '·';

/** Two entries can share time and kind (two sessions started in the same second): each key made unique. */
export function uniqueKeys(lines: Line[]): Line[] {
  const seen = new Map<string, number>();
  return lines.map(line => {
    const n = seen.get(line.key) ?? 0;
    seen.set(line.key, n + 1);
    return n ? { ...line, key: `${line.key}#${n}` } : line;
  });
}
