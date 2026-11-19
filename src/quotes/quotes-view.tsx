import { useState } from 'react';
import { amountRange, getQuotes, quoteStatusLabels, quotesKey, type QuoteFilters } from '../api/quotes';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { dateLabel, forgetCentral, startCentral, useCentralRead, useCentralRereading } from '../central/use-central-view';
import { HIDDEN, QuotesProblem, StatusBadge } from './quotes-common';
import { QuoteDetail } from './quote-detail';
import { QuoteDraftForm } from './quote-draft-form';
import { OpenInCentral } from '../central/open-in-central';
import '../central/central.css';
import './quotes.css';

const ALL = '';

type Mode = { kind: 'list' } | { kind: 'record'; id: string } | { kind: 'new' };

/** The «Presupuestos» section: Central's quotes with filters by client and state, each quote's record with its PDF
 * and Word, and a new draft created in Central only after seeing exactly what will be created. Never sends a quote
 * nor changes its state: that is done in Central. In discreet mode amounts, clients, titles and projects are hidden and nothing is
 * created nor opened. */
export function QuotesView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  useState(startCentral);  // once per visit: nothing read before is shown as current
  const rereading = useCentralRereading();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [filters, setFilters] = useState<QuoteFilters>({});
  const [made, setMade] = useState<string | null>(null);
  const all = useCentralRead(quotesKey(), () => getQuotes());
  const read = useCentralRead(quotesKey(filters), () => getQuotes(filters));
  const names = [...new Set((all.data?.quotes ?? []).map(q => q.client).filter((n): n is string => Boolean(n)))].sort((a, b) => a.localeCompare(b, 'es'));
  const failure = all.failure ?? read.failure;
  const ready = !failure && all.data;
  return <section className="page central quotes" aria-labelledby="quotes-title">
    <div className="eyebrow">PRESUPUESTOS · DE CENTRAL{discreet ? ' · MODO DISCRETO' : ''}</div>
    <div className="central-head">
      <h1 id="quotes-title">Presupuestos</h1>
      {ready && mode.kind === 'list' && <div className="actions central-actions">
        <button type="button" className="button" disabled={rereading} onClick={() => { setMade(null); forgetCentral(); }}>{rereading ? 'Leyendo…' : 'Volver a leer'}</button>
        {!discreet && <button type="button" className="button primary" onClick={() => { setMade(null); setMode({ kind: 'new' }); }}>Nuevo borrador</button>}
      </div>}
    </div>
    <p className="page-lead">Tus presupuestos de Central, leídos ahora mismo. Desde aquí se consultan, se abren en PDF o Word, se crean borradores y, con una clave con permiso «escritura», se cambian el estado y la fecha de sus hitos de pago; enviarlos y cambiar su estado se hace en Central.</p>
    {failure ? <QuotesProblem failure={failure} onRetry={() => { all.reload(); read.reload(); }} onOpen={onOpen}/>
      : mode.kind === 'record' ? <QuoteDetail id={mode.id} discreet={discreet} onBack={() => setMode({ kind: 'list' })} onOpen={onOpen}/>
      : mode.kind === 'new' && !discreet ? <QuoteDraftForm clientNames={names} onOpen={onOpen} onCancel={() => setMode({ kind: 'list' })}
        onCreated={text => { setMade(text); setMode({ kind: 'list' }); forgetCentral(); }}/>
      : <div className="central-panel">
        {made && <p className="notice ok-note" role="status">{made}</p>}
        <div className="field-row central-filters">
          <label className="field">Cliente<ModernSelect value={filters.cliente ?? ALL} onChange={value => setFilters({ ...filters, cliente: value || undefined })}
            options={[{ value: ALL, label: 'Todos' }, ...names.map(name => ({ value: name, label: discreet ? HIDDEN : name }))]}/></label>
          <label className="field">Estado<ModernSelect value={filters.estado ?? ALL} onChange={value => setFilters({ ...filters, estado: value || undefined })}
            options={[{ value: ALL, label: 'Todos' }, ...Object.entries(quoteStatusLabels).map(([value, label]) => ({ value, label }))]}/></label>
        </div>
        {!read.data ? <Loading label="Leyendo los presupuestos de Central" lines={4}/>
          : !read.data.quotes.length ? <p className="muted">{filters.cliente || filters.estado ? 'Ningún presupuesto con estos filtros.' : 'Central no tiene presupuestos.'}</p>
          : <table className="data-table central-table">
            <thead><tr><th>Número</th><th>Cliente</th><th>Título</th><th>Estado</th><th className="num">Total con IVA</th><th>Fecha</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
            <tbody>{read.data.quotes.map((q, index) => <tr key={q.id ?? index}>
              <td><strong>{q.number ?? '—'}</strong></td>
              <td>{discreet ? HIDDEN : q.client ?? '—'}</td>
              <td>{discreet ? HIDDEN : q.title ?? '—'}</td>
              <td><StatusBadge status={q.status}/></td>
              <td className="num">{discreet ? HIDDEN : amountRange(q.total, q.totalMax)}</td>
              <td className="central-date">{dateLabel(q.issuedAt)}</td>
              <td className="central-row-actions">{q.id && <span className="actions">
                <button type="button" className="button" onClick={() => setMode({ kind: 'record', id: q.id! })}>Ver</button>
                <OpenInCentral page={`presupuestos/${q.id}`} discreet={discreet}/></span>}</td>
            </tr>)}</tbody>
          </table>}
      </div>}
  </section>;
}
