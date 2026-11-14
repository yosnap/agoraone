import type { ProfileActivity } from '../../shared/hermes-activity';
import type { ChatState } from '../ui/chat-panel';

// What an agent is doing right now, from real records only: its chat in AgoraOne, the tools and scheduled
// tasks Hermes logged in the last minutes, and its gateway connections. Nothing here is guessed or animated.

export type AgentStatus = { state: 'approval' | 'answering' | 'tool' | 'job' | 'live' | 'connected' | 'idle'; label: string; detail?: string };

const recent = (at: string | null | undefined, minutes: number, now: number) => !!at && now - Date.parse(at) < minutes * 60_000;

export function agentStatus(activity: ProfileActivity | undefined, chat: ChatState | undefined, now = Date.now()): AgentStatus {
  if (chat?.approvals) return { state: 'approval', label: 'Espera tu permiso' };
  if (chat?.busy) return { state: 'answering', label: 'Respondiéndote en AgoraOne' };
  const tools = [...(activity?.usage?.tools ?? []), ...(activity?.usage?.mcp.flatMap(server => server.tools.map(tool => ({ ...tool, name: `${server.name} · ${tool.name}` }))) ?? [])];
  const tool = tools.filter(item => recent(item.lastUsedAt, 2, now)).sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))[0];
  if (tool) return { state: 'tool', label: 'Usando una herramienta', detail: tool.name };
  const job = activity?.jobs?.find(item => recent(item.lastRunAt, 5, now));
  if (job) return { state: 'job', label: 'Ejecutó una tarea programada', detail: job.name };
  if (recent(activity?.lastActivityAt, 2, now)) return { state: 'live', label: 'Trabajando ahora' };
  const links = activity?.platforms.filter(link => link.state === 'connected').map(link => link.name) ?? [];
  if (links.length) return { state: 'connected', label: 'Conectado', detail: links.join(', ') };
  return { state: 'idle', label: 'Sin conexión' };
}

/** States worth a bubble over the agent in the 3D office. Connected or idle show only on its card, and
 * recent activity already reads «actividad registrada» on its label. */
export const shownInWorld = (status: AgentStatus) => !['connected', 'idle', 'live'].includes(status.state);
