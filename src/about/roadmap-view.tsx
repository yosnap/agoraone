import { roadmap, type RoadmapStatus } from './roadmap-data';
import './about.css';

const columns: { status: RoadmapStatus; label: string; icon: string; note: string }[] = [
  { status: 'doing', label: 'En curso', icon: '▶', note: 'Se está haciendo ahora.' },
  { status: 'planned', label: 'Planificado', icon: '◷', note: 'Decidido; llegará en las próximas versiones.' },
  { status: 'idea', label: 'Pensado', icon: '○', note: 'Ideas sin fecha; pueden cambiar o caerse.' },
];

/** What comes next, by status (Ajustes › Hoja de ruta). Nothing here is a promise. */
export function RoadmapCard() {
  return <article className="card about-card" aria-labelledby="settings-roadmap">
    <div className="card-head"><h2 id="settings-roadmap">Hoja de ruta</h2></div>
    <p>Lo que viene en AgoraOne. Se va completando poco a poco; cuando algo se publica pasa a Novedades.</p>
    <div className="roadmap-columns">
      {columns.map(column => {
        const items = roadmap.filter(item => item.status === column.status);
        return <section key={column.status} className="roadmap-column" aria-labelledby={`roadmap-${column.status}`}>
          <h3 id={`roadmap-${column.status}`}><span className={`about-kind roadmap-${column.status}`}><span aria-hidden="true">{column.icon}</span> {column.label}</span> <span className="muted">{items.length}</span></h3>
          <p className="muted">{column.note}</p>
          {items.length ? <ul className="roadmap-items">{items.map(item => <li key={item.title}>
            <strong>{item.title}</strong>
            <span className="about-area">{item.area}{item.version ? ` · ${item.version}` : ''}</span>
            <p>{item.detail}</p>
          </li>)}</ul> : <p className="muted">Nada por ahora.</p>}
        </section>;
      })}
    </div>
  </article>;
}
