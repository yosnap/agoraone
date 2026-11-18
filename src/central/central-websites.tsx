import { useState } from 'react';
import { getCentralView, webKindLabels } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { CentralProblem } from './central-connect';
import { dateLabel, useCentralRead, viewKey } from './use-central-view';

const ALL = '';

/** Webs: the websites Central watches with their last check (up or down, code, time), all or only the ones down. */
export function CentralWebsites({ onOpen }: { onOpen: (section: Section) => void }) {
  const [kind, setKind] = useState(ALL);
  const [onlyDown, setOnlyDown] = useState(false);
  const params = { tipo: kind || undefined, caidas: onlyDown ? '1' : undefined };
  const read = useCentralRead(viewKey('webs', params), () => getCentralView('webs', params));
  const websites = read.data?.websites ?? [];
  const down = websites.filter(w => w.status === 'down').length;
  return <>
    <div className="field-row central-filters">
      <label className="field">Tipo<ModernSelect value={kind} onChange={setKind}
        options={[{ value: ALL, label: 'Todas' }, ...Object.entries(webKindLabels).map(([value, label]) => ({ value, label }))]}/></label>
      <div className="segmented" role="group" aria-label="Qué webs">
        <button type="button" aria-pressed={!onlyDown} onClick={() => setOnlyDown(false)}>Todas</button>
        <button type="button" aria-pressed={onlyDown} onClick={() => setOnlyDown(true)}>Solo caídas</button>
      </div>
    </div>
    {read.failure ? <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo las webs de Central" lines={4}/>
      : !websites.length ? <p className={onlyDown ? 'ok-note' : 'muted'} role="status">{onlyDown ? 'Ninguna web caída en la última comprobación.' : 'Central no vigila ninguna web de este tipo.'}</p>
      : <>
        <p className="muted">{websites.length} webs{onlyDown ? '' : ` · ${down} caídas en la última comprobación`}</p>
        <table className="data-table central-table">
          <thead><tr><th>Web</th><th>Tipo</th><th>Cliente</th><th>Estado</th><th className="num">Código</th><th className="num">Tiempo</th><th>Última</th></tr></thead>
          <tbody>{websites.map((w, index) => <tr key={w.id ?? index}>
            <td className="central-url"><strong>{w.url?.replace(/^https?:\/\//, '') ?? 'Dirección oculta'}</strong></td>
            <td>{webKindLabels[w.kind ?? ''] ?? '—'}</td>
            <td>{w.client ?? '—'}</td>
            <td><span className={`status-badge ${w.status === 'up' ? 'good' : w.status === 'down' ? 'bad' : 'neutral'}`}>
              {w.status === 'up' ? 'En línea' : w.status === 'down' ? 'Caída' : 'Sin datos'}</span></td>
            <td className="num">{w.code ?? '—'}</td>
            <td className="num">{w.ms != null ? `${w.ms} ms` : '—'}</td>
            <td>{dateLabel(w.checkedAt)}</td>
          </tr>)}</tbody>
        </table>
      </>}
  </>;
}
