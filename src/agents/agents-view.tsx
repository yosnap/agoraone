import { useRef } from 'react';
import { agentStatus, type AgentStatus } from '../office/agent-state';
import { useAssistantName } from '../assistant/assistant-name';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ago, BLOCKED, describe, describeWatson, outcomeLabel, RUNNING, sourceLabel, uniqueKeys, until, type Line } from './agent-lines';
import { refreshAgents, useAgentsFeed } from './agents-feed';
import { requestOffice } from '../office/office-focus';
import { CodingSessions } from './coding-sessions';
import { OrcaBotsPanel } from '../orca/orca-bots';
import './agents.css';
import { ActionButton } from '../ui/action-button';

const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);

/** «Agentes» (1.7, user's request): who is working right now and on what, from real records only (Watson's answers
 * and action log, Hermes' sessions, tools, scheduled tasks, kanban and gateway), and what each did in the last 24 h,
 * newest first. Read-only: the buttons only open the place where each agent is handled. */
export function AgentsView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const assistant = useAssistantName();
  const feed = useAgentsFeed();
  const seen = useRef<Set<string> | null>(null);
  const { catalog, activity, work, watson } = feed;
  const name = (id: string | null) => (id && (catalog?.profiles.find(p => p.id === id)?.label ?? work?.profiles[id]?.name)) || id || 'sin asignar';
  const cards = work?.board?.cards ?? [];
  const now = feed.readAt ?? Date.now();

  const lines: Line[] = uniqueKeys([
    ...Object.entries(activity?.profiles ?? {}).flatMap(([id, profile]) => profile.events
      .filter(event => event.kind !== 'link' || event.state !== 'connected').map(event => ({ ...describe(event, name(id), discreet), key: `${id}|${describe(event, id).key}` }))),
    ...(watson?.events ?? []).map(event => describeWatson(event, assistant)),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80));
  // What arrived since the previous reading is marked for a moment (nothing on the first one).
  const fresh = seen.current ? new Set(lines.filter(line => !seen.current!.has(line.key)).map(line => line.key)) : new Set<string>();
  if (feed.readAt) seen.current = new Set(lines.map(line => line.key));

  const watsonState: AgentStatus = watson?.answering ? { state: 'answering', label: 'Respondiéndote ahora' }
    : watson?.lastAt && now - Date.parse(watson.lastAt) < 2 * 60_000 ? { state: 'live', label: 'Trabajando ahora' }
    : { state: watson ? 'connected' : 'idle', label: watson ? 'Disponible' : 'Sin datos' };
  const profiles = (catalog?.profiles ?? []).map(profile => {
    const own = activity?.profiles[profile.id];
    const status = agentStatus(own, undefined, now);
    const running = cards.filter(card => (card.profileId ?? card.assignee) === profile.id && RUNNING.has(card.status));
    const blocked = cards.filter(card => (card.profileId ?? card.assignee) === profile.id && BLOCKED.has(card.status)).length;
    const next = (own?.jobs ?? []).filter(job => job.enabled && job.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
    const tasks = work?.profiles[profile.id]?.tasks ?? [];
    const day = [...tasks.map(task => task.totals['24h']), ...cards.filter(card => card.profileId === profile.id).map(card => card.totals['24h'])]
      .reduce((sum, total) => ({ runs: sum.runs + total.runs, tokens: sum.tokens + total.tokens.input + total.tokens.output }), { runs: 0, tokens: 0 });
    return { profile, own, status, running, blocked, next, day };
  });
  const coders = (feed.coding ?? []).filter(session => session.state === 'working').length;
  const working = coders + (profiles.filter(p => !['connected', 'idle'].includes(p.status.state)).length) + (['answering', 'live'].includes(watsonState.state) ? 1 : 0);
  const gateway = activity?.gateway;

  return <section className="page agents" aria-labelledby="agents-title">
    <div className="eyebrow">AGENTES{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="agents-title">Agentes</h1>
    <p className="page-lead">Quién trabaja ahora y en qué, y lo que ha hecho cada uno en las últimas 24 horas. Todo sale de los registros reales de {assistant}, de Hermes y de Claude Code y Codex en este Mac (nunca el texto de las conversaciones) y se actualiza solo cada 15 segundos.</p>
    <div className="agents-bar" role="status">
      <span className={`chip ${working ? 'agents-busy' : ''}`}>{working ? `${working} ${working === 1 ? 'agente trabajando' : 'agentes trabajando'}` : 'Nadie trabajando ahora'}</span>
      {gateway && <span className="chip">Gateway de Hermes: {gateway.state === 'running' ? `en marcha${gateway.activeAgents ? ` · ${gateway.activeAgents} en curso` : ''}` : gateway.state === 'stopped' ? 'detenido' : gateway.state === 'stale' ? 'sin datos recientes' : 'sin estado'}</span>}
      {feed.readAt && <small className="muted">Leído {ago(new Date(feed.readAt).toISOString())}</small>}
      <ActionButton icon="refresh" label="Actualizar" onClick={() => void refreshAgents()}/>
    </div>
    {feed.failed.length > 0 && <small className="dictation-error" role="status">No se pudo leer: {feed.failed.join(', ')}. Se muestra lo demás.</small>}
    {!feed.readAt ? <Loading label="Leyendo a los agentes" lines={4}/> : <div className="agents-layout">
      <div className="agents-main">
      <div className="agents-cards">
        <article className={`card agent-tile state-${watsonState.state}`}>
          <header><span className="agent-avatar watson" aria-hidden="true">{assistant.slice(0, 1)}</span>
            <div><strong>{assistant}</strong><small role="status">{watsonState.label}{watson?.since && watson.answering ? ` · desde ${ago(watson.since, now)}` : ''}</small></div></header>
          <p className="agent-facts">{watson?.lastAt ? `Última acción ${ago(watson.lastAt, now)} · ${watson.count} en 24 h` : 'Sin acciones en 24 h'}</p>
          <div className="agent-actions"><button type="button" className="button" onClick={() => onOpen('assistant')}>Conversar</button></div>
        </article>
        {profiles.map(({ profile, own, status, running, blocked, next, day }) => <article key={profile.id} className={`card agent-tile state-${status.state}`}>
          <header><span className="agent-avatar" style={{ background: profile.color }} aria-hidden="true">{profile.label.slice(0, 1).toUpperCase()}</span>
            <div><strong title={profile.label}>{profile.label}</strong><small role="status">{status.label}{status.detail ? ` · ${status.detail}` : ''}</small></div></header>
          <ul className="agent-facts">
            {running.map(card => <li key={card.id ?? card.title}><span className="chip">{card.status === 'review' ? 'en revisión' : 'en curso'}</span> {discreet ? 'Encargo' : card.title} · {ago(card.startedAt ?? card.createdAt, now)}</li>)}
            {blocked > 0 && <li><span className="chip agents-alert">bloqueado</span> {blocked} {blocked === 1 ? 'encargo necesita' : 'encargos necesitan'} atención</li>}
            {next && <li>Próxima tarea: {discreet ? 'programada' : next.name} · {until(next.nextRunAt!, now)}</li>}
            <li>{own?.lastActivityAt ? `Última actividad ${ago(own.lastActivityAt, now)}` : 'Sin actividad registrada'}{own?.recent.length ? ` · ${own.recent.map(r => `${r.sessions} por ${sourceLabel[r.source] ?? r.source}`).join(', ')}` : ''}</li>
            {day.runs > 0 && <li>{day.runs} {day.runs === 1 ? 'ejecución' : 'ejecuciones'} en 24 h{day.tokens && !discreet ? ` · ${tokens(day.tokens)} tokens` : ''}</li>}
          </ul>
          <div className="agent-actions">
            <button type="button" className="button" onClick={() => { requestOffice(profile.id, 'chat'); onOpen('office'); }}>Conversar</button>
            <ActionButton icon="eye" label="Verlo en la ciudad" onClick={() => { requestOffice(profile.id, 'select'); onOpen('office'); }}/>
            <button type="button" className="button" onClick={() => onOpen('jobs')}>Tareas</button>
          </div>
        </article>)}
      </div>
        <CodingSessions sessions={feed.coding} discreet={discreet} now={now} onCity={() => { requestOffice('code-workshop', 'select'); onOpen('office'); }}/>
        <OrcaBotsPanel discreet={discreet}/>
      </div>
      <aside className="card agents-log" aria-label="Actividad de las últimas 24 horas">
        <strong>Actividad · últimas 24 h</strong>
        {lines.length === 0 ? <small className="muted">Nada registrado en las últimas 24 horas.</small>
          : <ul className="agent-log">{lines.map(line => <li key={line.key} className={fresh.has(line.key) ? 'fresh' : undefined}>
            <span className={`agent-outcome ${line.outcome ?? 'none'}`}>{outcomeLabel(line.outcome)}</span>
            <span><strong>{line.who}</strong> {line.text}</span><small>{ago(line.at, now)}</small>
          </li>)}</ul>}
      </aside>
    </div>}
  </section>;
}
