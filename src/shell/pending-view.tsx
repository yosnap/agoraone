import type { Section } from './shell-state';
import { sectionLabel } from './shell-nav';

const plans: Partial<Record<Section, { version: string; text: string }>> = {
  jobs: { version: '1.2', text: 'Los trabajos de tus agentes y del bot central llegarán en la versión 1.2.' },
  meetings: { version: '1.3', text: 'Las reuniones grabadas y resumidas llegarán en la versión 1.3.' },
};

/** A section that does not exist yet: said plainly, with nothing simulated. */
export function PendingView({ section }: { section: Section }) {
  const plan = plans[section];
  return <section className="page page-pending" aria-labelledby="pending-title">
    <div className="eyebrow">PENDIENTE{plan ? ` · VERSIÓN ${plan.version}` : ''}</div>
    <h1 id="pending-title">{sectionLabel(section)}</h1>
    <p>{plan?.text ?? 'Esta sección aún no está disponible.'} Hasta entonces no muestra ningún dato.</p>
  </section>;
}
