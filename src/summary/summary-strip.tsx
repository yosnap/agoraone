import { compact, connectedAgents, uptime, useSummary } from './use-summary';
import { useAssistantName } from '../assistant/assistant-name';
import './summary.css';

/** One line over the brain's graph: Watson online and for how long, agents connected, today's tokens, the
 * busiest project and the words used most in the notes. «Ver resumen» opens the full page. */
export function SummaryStrip({ discreet, onOpen, tail }: { discreet: boolean; onOpen: () => void; /** The brain's totals, at the right end. */ tail?: string }) {
  const assistant = useAssistantName();
  const { summary } = useSummary(discreet);
  if (!summary.readAt) return null;
  const online = !!summary.engine?.active;
  const day = summary.core?.costguard.available ? summary.core.costguard['24h'] : null;
  const tokens = day?.agents.reduce((sum, agent) => sum + agent.input + agent.output, 0);
  const project = day?.projects[0]?.project;
  const words = summary.core?.noteWords.slice(0, 4).map(item => item.word) ?? [];
  return <div className="summary-strip" role="status" aria-label="Resumen rápido">
    <span className={online ? 'live' : 'off'}>● {online ? 'En línea' : 'Sin motor'}</span>
    {summary.core && <span>{assistant} <b>{uptime(summary.core.core.startedAt)}</b></span>}
    <span>Agentes <b>{connectedAgents(summary).length}</b></span>
    {tokens !== undefined && <span>Tokens 24 h <b>{compact(tokens)}</b></span>}
    {project && <span>Proyecto <b>{project}</b></span>}
    {words.length > 0 && <span>Palabras <b>{words.join(' · ')}</b></span>}
    <button onClick={onOpen}>Ver resumen</button>
    {tail && <span className="strip-tail">{tail}</span>}
  </div>;
}
