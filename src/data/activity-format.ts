import { recentActivityMs, type HermesActivity, type PlatformLink, type ProfileActivity } from '../../shared/hermes-activity';

export const platformStates: Record<PlatformLink['state'], string> = {
  connected: 'conectado', retrying: 'reintentando', attention: 'requiere atención', disconnected: 'desconectado', unknown: 'sin datos recientes',
};
const sources: Record<string, string> = { telegram: 'Telegram', desktop: 'Desktop', cron: 'tareas programadas', cli: 'terminal', tui: 'terminal', acp: 'editor (ACP)', subagent: 'subagentes', oneshot: 'ejecución única' };
export const sourceLabel = (source: string) => sources[source] || source;
const statuses: Record<string, string> = {
  ok: 'correcto', error: 'con error', failed: 'con error', scheduled: 'programada', paused: 'en pausa', running: 'en curso',
  triage: 'por clasificar', todo: 'pendiente', ready: 'lista', blocked: 'bloqueada', review: 'en revisión', done: 'hecha', archived: 'archivada',
};
export const statusLabel = (status: string | null) => status ? statuses[status] || status : 'sin datos';
const platformNames: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', slack: 'Slack', email: 'Correo' };
export const platformName = (name: string) => platformNames[name] || name;

export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return 'sin registro';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}
export const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'sin fecha';

/** True only when Hermes recorded activity for this profile in the last two minutes. */
export const recentlyActive = (activity: ProfileActivity | undefined, now = Date.now()) =>
  !!activity?.lastActivityAt && now - Date.parse(activity.lastActivityAt) < recentActivityMs;

export function gatewaySummary(activity: HermesActivity | null) {
  if (!activity) return 'Gateway Hermes · leyendo estado…';
  const { gateway } = activity;
  if (gateway.state === 'missing') return 'Gateway Hermes · sin estado registrado';
  if (gateway.state === 'stopped') return `Gateway Hermes · detenido${gateway.detail ? ` (${gateway.detail})` : ''}`;
  if (gateway.state === 'stale') return `Gateway Hermes · sin datos recientes (último ${ago(gateway.updatedAt)})`;
  const agents = gateway.activeAgents ?? 0;
  return `Gateway Hermes · en marcha · ${agents === 1 ? '1 agente trabajando' : `${agents} agentes trabajando`} ahora`;
}
