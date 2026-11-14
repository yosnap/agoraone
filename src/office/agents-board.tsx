import { useEffect, useState } from 'react';
import { getEngines } from '../api/core';
import type { HermesCatalog } from '../../shared/hermes-catalog';
import { engineName, modelName } from '../assistant/assistant-labels';
import type { AgentStatus } from './agent-state';
import './office.css';

/** The office's staff: Watson and every Hermes profile, each with what it is really doing and direct access
 * to its conversation, its tasks and kanban, and its own space. */
export function AgentsBoard({ catalog, statuses, onWatson, onChat, onTasks, onEnter }: {
  catalog: HermesCatalog | null; statuses: Record<string, AgentStatus>;
  onWatson: () => void; onChat: (id: string) => void; onTasks: (id: string) => void; onEnter: (id: string) => void;
}) {
  const [engine, setEngine] = useState<{ active: string | null; model: string } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => getEngines().then(data => { if (live) setEngine(data); }).catch(() => { if (live) setEngine({ active: null, model: '' }); });
    void read();
    const timer = setInterval(read, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return <section className="agents-board" aria-label="Oficina de agentes">
    <article className={`agent-card ${engine?.active ? 'state-connected' : 'state-idle'}`}>
      <header><span className="agent-avatar watson" aria-hidden="true">W</span><div><strong>Watson</strong>
        <small>{engine?.active ? `En línea · ${engineName(engine.active)} · ${modelName(engine.model)}` : engine ? 'Sin motor disponible' : 'Comprobando…'}</small></div></header>
      <div className="agent-actions"><button onClick={onWatson}>Conversar</button></div>
    </article>
    {(catalog?.profiles ?? []).map(profile => {
      const status = statuses[profile.id];
      return <article key={profile.id} className={`agent-card state-${status?.state ?? 'idle'}`}>
        <header><span className="agent-avatar" style={{ background: profile.color }} aria-hidden="true">{profile.label.slice(0, 1).toUpperCase()}</span><div>
          <strong title={profile.label}>{profile.label}</strong>
          <small role="status">{status?.label ?? '—'}{status?.detail ? ` · ${status.detail}` : ''}</small></div></header>
        <div className="agent-actions">
          <button onClick={() => onChat(profile.id)}>Conversar</button>
          <button onClick={() => onTasks(profile.id)}>Tareas</button>
          <button onClick={() => onEnter(profile.id)}>Su espacio</button>
        </div>
      </article>;
    })}
  </section>;
}
