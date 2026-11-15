import { useRef, useState } from 'react';
import { getBrainHome, type BrainArea, type GraphNode, type LatelyEntry } from '../api/core';

const ago = (stamp: string | null) => {
  if (!stamp) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(stamp).getTime()) / 60000));
  return minutes < 60 ? `hace ${minutes} min` : minutes < 1440 ? `hace ${Math.round(minutes / 60)} h` : `hace ${Math.round(minutes / 1440)} d`;
};
const hour = (stamp: string) => new Date(stamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** The brain's side (1.4): the areas of the vault, as CROW lists its catalogue (what each holds, how many
 * notes, when it changed; pressing one lights its notes up on the graph), and what changed today and
 * yesterday, as gbrain's «Lately». Real data only; discreet mode shows only normal notes. */
export function BrainSide({ discreet, nodes, colors, onFocus, onRead }: {
  discreet: boolean; nodes: GraphNode[]; colors: Map<string, string>; onFocus: (ids: string[]) => void; onRead: (key: string) => void;
}) {
  const [home, setHome] = useState<{ areas: BrainArea[]; lately: { today: LatelyEntry[]; yesterday: LatelyEntry[] } } | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const asked = useRef<boolean | null>(null);
  if (asked.current !== discreet) { asked.current = discreet; void getBrainHome(discreet).then(setHome).catch(() => setFailed(true)); }
  const pick = (area: string) => {
    if (picked === area) { setPicked(null); onFocus([]); return; }
    setPicked(area);
    onFocus(nodes.filter(n => n.type === 'note' && ((n.folder ?? '').split('/')[0].trim() === area)).map(n => n.id));
  };
  if (failed) return null;
  if (!home) return <p className="brain-stats">Leyendo las áreas…</p>;
  const day = (title: string, entries: LatelyEntry[]) => entries.length > 0 && <>
    <h3>{title}</h3>
    <ul className="lately">{entries.map(entry => <li key={`${entry.kind}-${entry.id}`}>
      <span className="lately-tag">{entry.kind}</span>
      {entry.key ? <button type="button" onClick={() => onRead(entry.key!)}>{entry.text}</button> : <span>{entry.text}</span>}
      <small>{entry.kind === 'reunión' ? entry.detail : hour(entry.when)}</small>
    </li>)}</ul>
  </>;
  return <div className="brain-side">
    <h2>Áreas</h2>
    <ul className="areas">{home.areas.map(area => <li key={area.name}>
      <button type="button" aria-pressed={picked === area.name} onClick={() => pick(area.name)}
        title={picked === area.name ? 'Quitar el resaltado' : 'Resaltar sus notas en el grafo'}>
        <span className="area-dot" style={{ background: colors.get(area.name) ?? 'var(--c-8a9a91)' }} aria-hidden="true"/>
        <span className="area-text">
          <span className="area-head"><strong>{area.name || 'Raíz'}</strong><small>{area.notes}</small></span>
          {area.description && <small className={area.written ? '' : 'area-auto'}>{area.description}</small>}
          <small className="area-when">{area.subfolders ? `${area.subfolders} subcarpetas · ` : ''}{ago(area.changed)}</small>
        </span>
      </button>
    </li>)}</ul>
    {(home.lately.today.length > 0 || home.lately.yesterday.length > 0) && <h2>Últimamente</h2>}
    {day('Hoy', home.lately.today)}
    {day('Ayer', home.lately.yesterday)}
  </div>;
}
