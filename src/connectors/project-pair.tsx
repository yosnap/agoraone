import { useCallback, useEffect, useState } from 'react';
import { getProjectLinks, setProjectLink, type ProjectLinks } from '../api/clients';
import { projectStatusLabels as centralStatus } from '../api/central';
import { labelOf, projectStatusLabels as crmdevStatus } from '../crmdev/crmdev-labels';
import { ActionButton } from '../ui/action-button';
import { ModernSelect } from '../ui/modern-select';
import { Facts } from '../ui/record-layout';

type Side = 'central' | 'crmdev';
const OTHER: Record<Side, string> = { central: 'CRMDev', crmdev: 'Central' };

/** The pair of a project on the other side (Central ↔ CRMDev): which one it is and how it was paired, the suggestions
 * («Enlazar» / «Son distintos») and a picker to link it by hand. Linking only says they are the same project: nothing
 * is copied between them. */
export function ProjectPair({ side, id }: { side: Side; id: string }) {
  const [links, setLinks] = useState<ProjectLinks | null>(null);
  const [failure, setFailure] = useState('');
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => getProjectLinks().then(found => { setLinks(found); setFailure(''); })
    .catch(error => setFailure(error instanceof Error ? error.message : 'No se pudieron leer los enlaces de proyectos.')), []);
  useEffect(() => { void read(); }, [read]);
  if (failure) return <p className="error" role="alert">{failure}</p>;
  if (!links) return <p className="muted">Buscando el proyecto en {OTHER[side]}…</p>;
  const others = side === 'central' ? links.crmdev : links.central;
  if (!others.length) return <p className="muted">No hay proyectos leídos de {OTHER[side]}: conéctalo en Conectores o pulsa «Actualizar» allí.</p>;
  const mine = side === 'central' ? links.central.find(p => p.id === id) : links.crmdev.find(p => p.id === id);
  const pairId = mine ? (side === 'central' ? (mine as ProjectLinks['central'][number]).crmdevId : (mine as ProjectLinks['crmdev'][number]).centralId) : null;
  const pair = pairId ? others.find(p => p.id === pairId) : undefined;
  const ids = (otherId: string) => (side === 'central' ? [id, otherId] : [otherId, id]) as [string, string];
  const change = (otherId: string, state: 'linked' | 'distinct' | 'unlinked') => {
    setBusy(true);
    setProjectLink(...ids(otherId), state).then(read).catch(error => setFailure(error instanceof Error ? error.message : 'No se pudo guardar el enlace.'))
      .finally(() => { setBusy(false); setPicked(''); });
  };
  const statusOf = (status: string | null) => labelOf(side === 'central' ? crmdevStatus : centralStatus, status);
  if (pair && mine) return <>
    <Facts items={[[`En ${OTHER[side]}`, pair.name], ['Estado allí', statusOf(pair.status)],
      ['Enlazado', mine.how === 'user' ? 'Por ti' : 'Por tener el mismo nombre'], ...(side === 'crmdev' && 'repo' in pair ? [['Repositorio', pair.repo ?? '—'] as [string, string]] : [])]}/>
    <div className="actions">{mine.how === 'user'
      ? <ActionButton icon="close" label="Desenlazar" disabled={busy} onClick={() => change(pair.id, 'unlinked')}/>
      : <ActionButton icon="close" label="Son distintos" disabled={busy} onClick={() => change(pair.id, 'distinct')}/>}</div>
  </>;
  const hints = links.suggestions.filter(s => (side === 'central' ? s.centralId : s.crmdevId) === id);
  const free = others.filter(p => !(side === 'central' ? (p as ProjectLinks['crmdev'][number]).centralId : (p as ProjectLinks['central'][number]).crmdevId));
  return <>
    <p className="muted">Sin proyecto enlazado en {OTHER[side]}.</p>
    {hints.map(hint => {
      const otherId = side === 'central' ? hint.crmdevId : hint.centralId;
      const name = side === 'central' ? hint.crmdevName : hint.centralName;
      return <div key={otherId} className="field-row">
        <span>¿Es «{name ?? 'sin nombre'}»?</span>
        <span className="actions"><ActionButton icon="link" label="Enlazar" disabled={busy} onClick={() => change(otherId, 'linked')}/>
          <ActionButton icon="close" label="Son distintos" disabled={busy} onClick={() => change(otherId, 'distinct')}/></span>
      </div>;
    })}
    {free.length > 0 && <div className="field-row">
      <label className="field">Enlazar con un proyecto de {OTHER[side]}<ModernSelect value={picked} onChange={setPicked}
        options={[{ value: '', label: 'Elige un proyecto' }, ...free.map(p => ({ value: p.id, label: p.name }))]}/></label>
      <ActionButton icon="link" label="Enlazar" disabled={!picked || busy} onClick={() => change(picked, 'linked')}/>
    </div>}
  </>;
}
