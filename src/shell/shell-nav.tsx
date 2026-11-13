import type { Section } from './shell-state';

type Item = { id: Section; label: string; icon: string; pending?: boolean };

const main: Item[] = [
  { id: 'brain', label: 'Cerebro', icon: '◉' },
  { id: 'assistant', label: 'Asistente', icon: '✦' },
  { id: 'office', label: 'Oficina 3D', icon: '▦' },
  { id: 'connectors', label: 'Conectores', icon: '⧉' },
];
// Planned for later versions: shown so the map is complete, marked as pending and without content.
const later: Item[] = [
  { id: 'inbox', label: 'Bandeja', icon: '✉', pending: true },
  { id: 'jobs', label: 'Trabajos', icon: '☰', pending: true },
  { id: 'meetings', label: 'Reuniones', icon: '◎', pending: true },
  { id: 'fiscal', label: 'Fiscal', icon: '€', pending: true },
];

export const sectionLabel = (id: Section) => [...main, ...later, { id: 'settings', label: 'Ajustes' }].find(item => item.id === id)?.label ?? '';

/** The left rail (a bottom bar on phones): the sections, discreet mode and the settings. */
export function ShellNav({ section, onSection, discreet, onDiscreet }: {
  section: Section; onSection: (section: Section) => void; discreet: boolean; onDiscreet: (on: boolean) => void;
}) {
  const button = (item: Item) => <li key={item.id}><button className={`rail-item${item.pending ? ' rail-pending' : ''}`}
    aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)} title={item.pending ? `${item.label}: pendiente` : item.label}>
    <span className="rail-icon" aria-hidden="true">{item.icon}</span><span className="rail-label">{item.label}</span>
    {item.pending && <span className="visually-hidden"> (pendiente)</span>}
  </button></li>;
  return <nav className="rail" aria-label="Secciones de AgoraOne">
    <a className="rail-brand" href="/" aria-label="AgoraOne">a</a>
    <ul className="rail-list">{main.map(button)}</ul>
    <ul className="rail-list rail-later" aria-label="Próximamente">{later.map(button)}</ul>
    <div className="rail-foot">
      <button className="rail-item rail-discreet" aria-pressed={discreet} onClick={() => onDiscreet(!discreet)}
        title={discreet ? 'Modo discreto activo: solo se ven las notas normales' : 'Modo discreto: ocultar lo privado y lo solo-local de la pantalla'}>
        <span className="rail-icon" aria-hidden="true">{discreet ? '◐' : '○'}</span><span className="rail-label">Discreto</span>
      </button>
      <button className="rail-item" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => onSection('settings')} title="Ajustes">
        <span className="rail-icon" aria-hidden="true">⚙</span><span className="rail-label">Ajustes</span>
      </button>
    </div>
  </nav>;
}
