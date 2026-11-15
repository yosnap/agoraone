import type { WorkCard } from '../../shared/hermes-work';
import { when } from '../data/activity-format';

// Hermes' kanban event kinds in words; an unknown kind shows as Hermes names it.
const labels: Record<string, string> = {
  created: 'Creada', promoted: 'Lista para empezar', promoted_manual: 'Puesta en marcha a mano', scheduled: 'Programada',
  claimed: 'Recogida por un agente', spawned: 'Agente en marcha', worker_registered: 'Agente en marcha', heartbeat: 'Sigue trabajando',
  completed: 'Completada', blocked: 'Bloqueada', unblocked: 'Desbloqueada', commented: 'Comentario', edited: 'Editada',
  reprioritized: 'Prioridad cambiada', review_requested: 'Revisión pedida', archived: 'Archivada', reclaimed: 'Reasignada',
  gave_up: 'Abandonada tras varios intentos', timed_out: 'Tiempo agotado', crashed: 'El agente falló', stale: 'Sin noticias del agente',
  linked: 'Enlazada con otra', unlinked: 'Desenlazada', attached: 'Adjunto añadido', attachment_removed: 'Adjunto quitado',
};
export const eventLabel = (kind: string) => labels[kind] ?? kind;

/** What happened to a card and when, from Hermes' own events (never their content), oldest first. */
export function CardHistory({ card }: { card: WorkCard }) {
  if (!card.events?.length) return null;
  return <details className="card-history"><summary>Historia ({card.events.length})</summary>
    <ol>{[...card.events].reverse().map((event, index) => <li key={index}><span>{eventLabel(event.kind)}</span> <small>{when(event.at)}</small></li>)}</ol>
  </details>;
}
