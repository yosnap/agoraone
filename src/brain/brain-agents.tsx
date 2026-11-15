import { useRef, useState } from 'react';
import { getHermesActivity, getHermesWork } from '../api/client';
import type { ActivityEvent, HermesActivity } from '../../shared/hermes-activity';
import type { HermesWork } from '../../shared/hermes-work';

const ago = (stamp: string | null) => {
  if (!stamp) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(stamp).getTime()) / 60000));
  return minutes < 60 ? `hace ${minutes} min` : minutes < 1440 ? `hace ${Math.round(minutes / 60)} h` : `hace ${Math.round(minutes / 1440)} d`;
};
const RUNNING = new Set(['claimed', 'running', 'review']);
const BLOCKED = new Set(['blocked', 'failed', 'crashed', 'timed_out']);
const sourceLabel: Record<string, string> = { telegram: 'Telegram', desktop: 'Desktop', cron: 'tarea programada', cli: 'terminal', api: 'API' };

type Line = { at: string; who: string; text: string; outcome: 'hecho' | 'falló' | null };
function describe(event: ActivityEvent, who: string): Line {
  if (event.kind === 'job') {
    const failed = event.status !== null && /fail|error|crash|timeout/i.test(event.status);
    return { at: event.at, who, text: `tarea «${event.name}»`, outcome: event.status === null ? null : failed ? 'falló' : 'hecho' };
  }
  if (event.kind === 'session') return { at: event.at, who, text: `conversación por ${sourceLabel[event.source] ?? event.source}`, outcome: null };
  if (event.kind === 'mcp') return { at: event.at, who, text: `${event.calls} ${event.calls === 1 ? 'llamada' : 'llamadas'} a ${event.server}`, outcome: null };
  return { at: event.at, who, text: `${event.name}: conexión ${event.state === 'disconnected' ? 'caída' : event.state}`, outcome: 'falló' };
}

/** «Agentes» at the brain's side (1.4, after gbrain's activity log): the commissions in progress on Hermes'
 * kanban, who has them and since when, and the last things the profiles did in 24 h with how they ended
 * (done or failed), read from Hermes' own records. Read-only; nothing here starts or changes anything. */
export function BrainAgents() {
  const [work, setWork] = useState<HermesWork | null>(null);
  const [activity, setActivity] = useState<HermesActivity | null>(null);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void getHermesWork().then(setWork).catch(() => setWork(null));
    void getHermesActivity().then(setActivity).catch(() => setActivity(null));
  }
  const name = (id: string | null) => (id && work?.profiles[id]?.name) || id || 'sin asignar';
  const cards = work?.board?.cards ?? [];
  const running = cards.filter(card => RUNNING.has(card.status)).slice(0, 4);
  const blocked = cards.filter(card => BLOCKED.has(card.status)).length;
  const lines = Object.entries(activity?.profiles ?? {}).flatMap(([id, profile]) => profile.events
    // A platform staying connected is not news; one that drops is.
    .filter(event => event.kind !== 'link' || event.state !== 'connected').map(event => describe(event, name(id))))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  if (!running.length && !blocked && !lines.length) return null;
  return <div className="brain-agents">
    <h2>Agentes</h2>
    {running.length > 0 && <ul className="today-list" aria-label="Encargos en curso">{running.map(card => <li key={card.id ?? card.title}>
      <span className="today-time">{card.status === 'review' ? 'revisión' : 'en curso'}</span>
      <span title={card.title}>{card.title} · <em>{name(card.profileId ?? card.assignee)}</em> {ago(card.startedAt ?? card.createdAt)}</span>
    </li>)}</ul>}
    {blocked > 0 && <p className="today-line"><span className="lately-tag">bloqueadas</span> {blocked} {blocked === 1 ? 'tarjeta necesita' : 'tarjetas necesitan'} atención en Trabajos</p>}
    {lines.length > 0 && <ul className="agent-log" aria-label="Actividad de las últimas 24 horas">{lines.map((line, index) => <li key={index}>
      <span className={`agent-outcome ${line.outcome ?? 'none'}`}>{line.outcome === 'hecho' ? 'Hecho' : line.outcome === 'falló' ? 'Falló' : '·'}</span>
      <span><strong>{line.who}</strong> {line.text}</span><small>{ago(line.at)}</small>
    </li>)}</ul>}
  </div>;
}
