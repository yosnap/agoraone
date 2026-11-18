import { useState } from 'react';
import { ApiError } from '../api/client';
import { amountRange, euros, getQuote, openQuoteDocument, phaseStatusLabels, type DocumentFormat, type QuoteRecord } from '../api/quotes';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { dateLabel, useCentralRead } from '../central/use-central-view';
import { HIDDEN, QuotesProblem, StatusBadge } from './quotes-common';
import { OpenInCentral } from '../central/open-in-central';

const documentLabels: Record<DocumentFormat, string> = { pdf: 'PDF', docx: 'Word' };

/** «Abrir PDF» and «Abrir Word»: the core downloads the document from Central and opens it with this computer's program. */
function DocumentButtons({ id }: { id: string }) {
  const [busy, setBusy] = useState<DocumentFormat | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const open = async (format: DocumentFormat) => {
    setBusy(format); setSaid(null);
    try {
      const { opened } = await openQuoteDocument(id, format);
      setSaid({ ok: true, text: `Abierto ${opened} con el programa del sistema. La copia se borra sola al día siguiente.` });
    } catch (error) {
      setSaid({ ok: false, text: error instanceof ApiError || error instanceof Error ? error.message : `No se pudo abrir el ${documentLabels[format]}.` });
    } finally { setBusy(null); }
  };
  return <>
    <div className="actions central-actions">
      {(['pdf', 'docx'] as DocumentFormat[]).map(format => <button key={format} type="button" className="button" disabled={busy !== null} onClick={() => void open(format)}>
        {busy === format ? `Abriendo el ${documentLabels[format]}…` : `Abrir ${documentLabels[format]}`}</button>)}
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </>;
}

function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return <section aria-label={title}><h3>{title}</h3><ul className="quotes-lines">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul></section>;
}

function Body({ q, discreet }: { q: QuoteRecord; discreet: boolean }) {
  const money = (from: number | null, to?: number | null) => (discreet ? HIDDEN : amountRange(from, to));
  const facts: [string, string][] = [
    ['Cliente', discreet ? HIDDEN : q.client?.name ?? '—'], ['Proyecto', discreet ? HIDDEN : q.project?.name ?? '—'], ['Fecha', dateLabel(q.issuedAt)],
    ['Válido hasta', dateLabel(q.validUntil)], ['IVA', q.vat != null ? `${q.vat} %` : '—'],
  ];
  return <>
    <dl className="central-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {q.scope && <section aria-label="Alcance"><h3>Objeto y alcance</h3><p className="quotes-text">{q.scope}</p></section>}
    <section aria-label="Partidas"><h3>Partidas</h3>
      {!q.items.length ? <p className="muted">Sin partidas.</p> : <table className="data-table central-table">
        <thead><tr><th>Concepto</th><th className="num">Cantidad</th><th className="num">Precio sin IVA</th><th className="num">Importe</th></tr></thead>
        <tbody>{q.items.map((item, index) => {
          const quantity = item.quantity ?? 1;
          return <tr key={index}>
            <td><strong>{item.description ?? '—'}</strong>{item.details && <small className="muted quotes-text"><br/>{item.details}</small>}</td>
            <td className="num">{quantity.toLocaleString('es-ES')}{item.unit ? ` ${item.unit}` : ''}</td>
            <td className="num">{money(item.unitPrice, item.priceMax)}</td>
            <td className="num">{money(item.unitPrice != null ? item.unitPrice * quantity : null, item.priceMax != null ? item.priceMax * quantity : null)}</td>
          </tr>;
        })}</tbody>
      </table>}
      <dl className="central-facts quotes-totals">
        <div><dt>Base</dt><dd>{money(q.base, q.baseMax)}</dd></div>
        <div><dt>IVA{q.vat != null ? ` (${q.vat} %)` : ''}</dt><dd>{discreet ? HIDDEN : euros(q.tax)}</dd></div>
        <div><dt>Total con IVA</dt><dd><strong>{money(q.total, q.totalMax)}</strong></dd></div>
      </dl>
    </section>
    {q.phases.length > 0 && <section aria-label="Hitos de pago"><h3>Hitos de pago</h3>
      <table className="data-table central-table">
        <thead><tr><th>Hito</th><th className="num">Porcentaje</th><th className="num">Importe</th><th>Fecha</th><th>Estado</th></tr></thead>
        <tbody>{q.phases.map((p, index) => <tr key={index}>
          <td>{p.name ?? '—'}</td><td className="num">{p.percent != null ? `${p.percent} %` : '—'}</td><td className="num">{money(p.amount)}</td>
          <td>{p.dueDate ? dateLabel(p.dueDate) : '—'}</td><td>{p.status ? phaseStatusLabels[p.status] : '—'}</td>
        </tr>)}</tbody>
      </table></section>}
    <Lines title="Incluye" lines={q.includes}/>
    <Lines title="No incluye" lines={q.excludes}/>
    <Lines title="Supuestos y condiciones" lines={q.assumptions}/>
    {q.schedule.length > 0 && <section aria-label="Cronograma"><h3>Cronograma</h3>
      <dl className="central-facts">{q.schedule.map((s, index) => <div key={index}><dt>{s.when ?? '—'}</dt><dd>{s.what ?? '—'}</dd></div>)}</dl></section>}
    {q.thirdPartyCosts && <section aria-label="Costes de terceros"><h3>Costes de terceros</h3><p className="quotes-text">{discreet ? HIDDEN : q.thirdPartyCosts}</p></section>}
    {q.notes && <section aria-label="Notas"><h3>Notas</h3><p className="quotes-text">{discreet ? 'Ocultas en modo discreto.' : q.notes}</p></section>}
  </>;
}

/** A quote's record, read-only: lines, payment milestones, base, VAT and total, and its PDF and Word. */
export function QuoteDetail({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`presupuesto:${id}`, () => getQuote(id));
  const back = <div className="actions central-actions"><button type="button" className="button" onClick={onBack}>Volver a la lista</button></div>;
  if (read.failure) return <>{back}<QuotesProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <>{back}<Loading label="Leyendo el presupuesto" lines={5}/></>;
  const q = read.data;
  return <article className="card central-record" aria-labelledby="quote-title">
    <div className="card-head">
      <div><h2 id="quote-title">{q.number ?? 'Presupuesto'} · {discreet ? HIDDEN : q.title ?? '—'}</h2><small className="muted">De Central · solo lectura</small></div>
      <StatusBadge status={q.status}/>
    </div>
    <Body q={q} discreet={discreet}/>
    {discreet ? <p className="muted">En modo discreto no se abren documentos.</p> : <DocumentButtons id={id}/>}
    <OpenInCentral page={`presupuestos/${id}`} discreet={discreet}/>
    {back}
  </article>;
}
