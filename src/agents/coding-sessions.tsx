import type { CodingHost, CodingSession } from '../api/core';
import { ago } from './agent-lines';

const tools: Record<CodingSession['tool'], string> = { claude: 'Claude Code', codex: 'Codex' };
/** Where each session runs, as its own record says (Orca, VS Code, the Codex or Claude app, a terminal). */
export const hosts: Record<CodingHost, string> = { orca: 'Orca', vscode: 'VS Code', 'codex-app': 'app de Codex', 'claude-desktop': 'app de Claude', terminal: 'Terminal', sdk: 'SDK' };
const states: Record<CodingSession['state'], string> = { working: 'Trabajando', tool: 'Herramienta o tu permiso', waiting: 'Te espera', paused: 'En pausa' };
const count = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);

/** The coding agents of this Mac (Claude Code and Codex) moved in the last 24 h, from their own local records:
 * project, branch, model, whether it works or waits for you, and tokens of the day (without cache reads).
 * Never what was said: the core does not even keep it. */
export function CodingSessions({ sessions, discreet, now, onCity, compact = false }: { sessions: CodingSession[] | null; discreet: boolean; now: number; onCity?: () => void; compact?: boolean }) {
  if (sessions === null) return null;
  const working = sessions.filter(s => s.state === 'working').length;
  return <section className={`coding-sessions${compact ? ' compact' : ''}`} aria-labelledby="coding-title">
    <div className="card-head"><h2 id="coding-title" className={compact ? 'visually-hidden' : undefined}>Agentes de código en este Mac</h2>
      {onCity && <button type="button" className="button" onClick={onCity}>Verlos en la ciudad</button>}</div>
    <p className="muted">{sessions.length === 0 ? 'Ninguna sesión de Claude Code ni de Codex en las últimas 24 horas.'
      : `${sessions.length} ${sessions.length === 1 ? 'sesión' : 'sesiones'} en 24 h${working ? `, ${working} trabajando ahora` : ''}. Solo se leen sus metadatos.`}</p>
    {sessions.length > 0 && <ul className="coding-list">{sessions.map(session => <li key={session.id} className={`card coding-row state-${session.state}`}>
      <span className={`chip coding-state ${session.state}`}>{states[session.state]}</span>
      <span className="coding-name"><strong>{discreet ? 'Proyecto oculto' : session.project ?? 'Sin carpeta'}</strong>
        <small>{tools[session.tool]}{session.host ? ` en ${hosts[session.host]}` : ''}{session.model ? ` · ${session.model.replace(/^claude-/, '')}` : ''}{!discreet && session.branch ? ` · ${session.branch}` : ''}</small></span>
      <span className="coding-numbers">{discreet ? '•••' : `${count(session.tokens.input + session.tokens.output)} tokens`}<small>{session.turns} {session.turns === 1 ? 'respuesta' : 'respuestas'} en 24 h</small></span>
      <small className="coding-when">{session.state === 'working' ? 'ahora' : ago(session.lastAt, now)}</small>
    </li>)}</ul>}
  </section>;
}
