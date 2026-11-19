import { useState } from 'react';
import { getCentralView, webKindLabels, type CentralWebsiteRow } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { CentralProblem } from './central-connect';
import { OpenInCentral } from './open-in-central';
import { dateLabel, useCentralRead, viewKey } from './use-central-view';

const ALL = '';

/** What the «Estado» filter keeps: all, the ones up, the ones down, or those with something to look at (down, without
 * data or answering an error code). */
export type WebsiteStatusFilter = 'all' | 'up' | 'down' | 'alert';
export type WebsiteFilters = { client: string; status: WebsiteStatusFilter; text: string };

const hasAlert = (w: CentralWebsiteRow) => w.status !== 'up' || (w.code != null && w.code >= 400);

/** The websites the filters leave, in the order Central gave them; done on screen over what was read. */
export function filterWebsites(websites: CentralWebsiteRow[], { client, status, text }: WebsiteFilters): CentralWebsiteRow[] {
  const words = text.trim().toLocaleLowerCase('es').split(/\s+/).filter(Boolean);
  return websites.filter(w => (client === ALL || (w.client ?? '') === client)
    && (status === 'all' || (status === 'alert' ? hasAlert(w) : w.status === status))
    && words.every(word => `${w.url ?? ''} ${w.client ?? ''}`.toLocaleLowerCase('es').includes(word)));
}

const STATUS_OPTIONS: { value: WebsiteStatusFilter; label: string }[] = [
  { value: 'all', label: 'Todas' }, { value: 'up', label: 'En línea' }, { value: 'down', label: 'Caídas' }, { value: 'alert', label: 'Con avisos' }];

/** Webs: the websites Central watches with their last check (up or down, code, time), filtered by type (in Central),
 * and by client, state and a search over address and client (on screen). */
export function CentralWebsites({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [kind, setKind] = useState(ALL);
  const [filters, setFilters] = useState<WebsiteFilters>({ client: ALL, status: 'all', text: '' });
  const params = { tipo: kind || undefined };
  const read = useCentralRead(viewKey('webs', params), () => getCentralView('webs', params));
  const all = read.data?.websites ?? [];
  const clients = [...new Set(all.map(w => w.client).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, 'es'));
  const websites = filterWebsites(all, filters);
  const down = websites.filter(w => w.status === 'down').length;
  const filtered = filters.client !== ALL || filters.status !== 'all' || filters.text.trim() !== '';
  return <>
    <div className="field-row central-filters">
      <label className="field">Tipo<ModernSelect value={kind} onChange={setKind}
        options={[{ value: ALL, label: 'Todas' }, ...Object.entries(webKindLabels).map(([value, label]) => ({ value, label }))]}/></label>
      <label className="field">Cliente<ModernSelect value={filters.client} onChange={client => setFilters({ ...filters, client })}
        options={[{ value: ALL, label: 'Todos' }, ...clients.map(c => ({ value: c, label: c }))]}/></label>
      <label className="field">Estado<ModernSelect value={filters.status} onChange={status => setFilters({ ...filters, status: status as WebsiteStatusFilter })}
        options={STATUS_OPTIONS}/></label>
      <label className="field">Buscar<input type="search" value={filters.text} maxLength={200} placeholder="Dirección o cliente"
        onChange={event => setFilters({ ...filters, text: event.target.value })}/></label>
    </div>
    {read.failure ? <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo las webs de Central" lines={4}/>
      : !all.length ? <p className="muted" role="status">Central no vigila ninguna web de este tipo.</p>
      : !websites.length ? <p className={filters.status === 'down' ? 'ok-note' : 'muted'} role="status">
        {filters.status === 'down' ? 'Ninguna web caída con estos filtros en la última comprobación.' : 'Ninguna web coincide con estos filtros.'}</p>
      : <>
        <p className="muted">{filtered ? `${websites.length} de ${all.length} webs` : `${websites.length} webs`} · {down} caídas en la última comprobación</p>
        <table className="data-table central-table">
          <thead><tr><th>Web</th><th>Tipo</th><th>Cliente</th><th>Estado</th><th className="num">Código</th><th className="num">Tiempo</th><th>Última</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
          <tbody>{websites.map((w, index) => <tr key={w.id ?? index}>
            <td className="central-url"><strong>{w.url?.replace(/^https?:\/\//, '') ?? 'Dirección oculta'}</strong></td>
            <td>{webKindLabels[w.kind ?? ''] ?? '—'}</td>
            <td>{w.client ?? '—'}</td>
            <td><span className={`status-badge ${w.status === 'up' ? 'good' : w.status === 'down' ? 'bad' : 'neutral'}`}>
              {w.status === 'up' ? 'En línea' : w.status === 'down' ? 'Caída' : 'Sin datos'}</span></td>
            <td className="num">{w.code ?? '—'}</td>
            <td className="num">{w.ms != null ? `${w.ms} ms` : '—'}</td>
            <td className="central-date">{dateLabel(w.checkedAt)}</td>
            <td className="central-row-actions"><OpenInCentral page="webs" discreet={discreet}/></td>
          </tr>)}</tbody>
        </table>
      </>}
  </>;
}
