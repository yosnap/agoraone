import type { CodingSession } from '../api/core';
import { ago } from './agent-lines';

const tools: Record<CodingSession['tool'], string> = { claude: 'Claude Code', codex: 'Codex' };
const states: Record<CodingSession['state'], string> = { working: 'Trabajando', tool: 'Herramienta o tu permiso', waiting: 'Te espera', paused: 'En pausa' };
const count = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);

/** The coding agents of this Mac (Claude Code and Codex) moved in the last 24 h, from their own local records:
 * project, branch, model, whether it works or waits for you, and tokens of the day (without cache reads).
 * Never what was said: the core does not even keep it. */
export function CodingSessions({ sessions, discreet, now }: { sessions: CodingSession[] | null; discreet: boolean; now: number }) {
  if (sessions === null) return null;
  const working = sessions.filter(s => s.state === 'working').length;
  return <section className="coding-sessions" aria-labelledby="coding-title">
    <h2 id="coding-title">Agentes de código en este Mac</h2>
    <p className="muted">{sessions.length === 0 ? 'Ninguna sesión de Claude Code ni de Codex en las últimas 24 horas.'
      : `${sessions.length} ${sessions.length === 1 ? 'sesión' : 'sesiones'} en 24 h${working ? `, ${working} trabajando ahora` : ''}. Solo se leen sus metadatos.`}</p>
    {sessions.length > 0 && <ul className="coding-list">{sessions.map(session => <li key={session.id} className={`card coding-row state-${session.state}`}>
      <span className={`chip coding-state ${session.state}`}>{states[session.state]}</span>
      <span className="coding-name"><strong>{discreet ? 'Proyecto oculto' : session.project ?? 'Sin carpeta'}</strong>
        <small>{tools[session.tool]}{session.model ? ` · ${session.model.replace(/^claude-/, '')}` : ''}{!discreet && session.branch ? ` · ${session.branch}` : ''}</small></span>
      <span className="coding-numbers">{discreet ? '•••' : `${count(session.tokens.input + session.tokens.output)} tokens`}<small>{session.turns} {session.turns === 1 ? 'respuesta' : 'respuestas'} en 24 h</small></span>
      <small className="coding-when">{session.state === 'working' ? 'ahora' : ago(session.lastAt, now)}</small>
    </li>)}</ul>}
  </section>;
}
