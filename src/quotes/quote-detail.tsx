import { Fragment, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { amountRange, euros, getQuote, openQuoteDocument, phaseStatusLabels, type DocumentFormat, type QuoteRecord } from '../api/quotes';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { dateLabel, forgetCentral, useCentralRead } from '../central/use-central-view';
import { useWritePermissions } from '../central/central-change';
import { Block, Facts, RecordLayout } from '../ui/record-layout';
import { QuotePhaseEdit } from './quote-phase-edit';
import { HIDDEN, QuotesProblem, StatusBadge } from './quotes-common';
import { OpenInCentral } from '../central/open-in-central';
import { ActionButton } from '../ui/action-button';

const documentLabels: Record<DocumentFormat, string> = { pdf: 'PDF', docx: 'Word' };
const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });
/** A due date of Central (a day kept at noon UTC) as «1 dic 2026», whatever the zone of this computer. */
const dayLabel = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? '—' : day.format(at); };

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
  return <Block title={title}><ul className="quotes-lines">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul></Block>;
}

/** The payment milestones; with a key that may write, each one's state and due date are changed here. */
function Phases({ q, discreet, canWrite, onSaid }: { q: QuoteRecord; discreet: boolean; canWrite: boolean; onSaid: (said: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const money = (from: number | null) => (discreet ? HIDDEN : amountRange(from, null));
  if (!q.phases.length) return null;
  return <Block title="Hitos de pago" wide>
    <table className="data-table central-table">
      <thead><tr><th>Hito</th><th className="num">Porcentaje</th><th className="num">Importe</th><th>Fecha prevista</th><th>Estado</th><th>Completado</th>
        <th><span className="visually-hidden">Acciones</span></th></tr></thead>
      <tbody>{q.phases.map((p, index) => {
        const editable = canWrite && !discreet && q.id && p.id && p.revision ? { ...p, id: p.id, revision: p.revision } : null;
        return <Fragment key={p.id ?? index}>
          <tr>
            <td>{p.name ?? '—'}</td><td className="num">{p.percent != null ? `${p.percent} %` : '—'}</td><td className="num">{money(p.amount)}</td>
            <td className="central-date">{p.dueDate ? dayLabel(p.dueDate) : '—'}</td><td>{p.status ? phaseStatusLabels[p.status] : '—'}</td>
            <td className="central-date">{p.completedAt ? dateLabel(p.completedAt) : '—'}</td>
            <td className="central-row-actions">{editable && editing !== editable.id &&
              <ActionButton icon="edit" label="Cambiar" onClick={() => { onSaid(''); setEditing(editable.id); }}/>}</td>
          </tr>
          {editable && editing === editable.id && q.id && <tr><td colSpan={7}>
            <QuotePhaseEdit key={editable.revision} quoteId={q.id} phase={editable} onCancel={() => setEditing(null)} onReview={forgetCentral}
              onDone={said => { setEditing(null); onSaid(said); forgetCentral(); }}/>
          </td></tr>}
        </Fragment>;
      })}</tbody>
    </table>
  </Block>;
}

function Body({ q, discreet, phases }: { q: QuoteRecord; discreet: boolean; phases: ReactNode }) {
  const money = (from: number | null, to?: number | null) => (discreet ? HIDDEN : amountRange(from, to));
  const facts: [string, string][] = [
    ['Cliente', discreet ? HIDDEN : q.client?.name ?? '—'], ['Proyecto', discreet ? HIDDEN : q.project?.name ?? '—'], ['Fecha', dateLabel(q.issuedAt)],
    ['Válido hasta', dateLabel(q.validUntil)], ['IVA', q.vat != null ? `${q.vat} %` : '—'],
  ];
  return <>
    <Block title="Datos"><Facts items={facts}/></Block>
    <Block title="Importe">
      <Facts items={[['Base', money(q.base, q.baseMax)], [`IVA${q.vat != null ? ` (${q.vat} %)` : ''}`, discreet ? HIDDEN : euros(q.tax)],
        ['Total con IVA', <strong key="total">{money(q.total, q.totalMax)}</strong>]]}/>
    </Block>
    {q.scope && <Block title="Objeto y alcance" wide><p className="quotes-text">{q.scope}</p></Block>}
    <Block title="Partidas" wide>
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
    </Block>
    {phases}
    <Lines title="Incluye" lines={q.includes}/>
    <Lines title="No incluye" lines={q.excludes}/>
    <Lines title="Supuestos y condiciones" lines={q.assumptions}/>
    {q.schedule.length > 0 && <Block title="Cronograma"><Facts items={q.schedule.map(s => [s.when ?? '—', s.what ?? '—'])}/></Block>}
    {q.thirdPartyCosts && <Block title="Costes de terceros"><p className="quotes-text">{discreet ? HIDDEN : q.thirdPartyCosts}</p></Block>}
    {q.notes && <Block title="Notas"><p className="quotes-text">{discreet ? 'Ocultas en modo discreto.' : q.notes}</p></Block>}
  </>;
}

/** A quote's record: lines, payment milestones (their state and due date changed here with a key that may write),
 * base, VAT and total, its PDF and Word, and the rest in Central. */
export function QuoteDetail({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`presupuesto:${id}`, () => getQuote(id));
  const can = useWritePermissions();
  const [said, setSaid] = useState('');
  const back = <ActionButton icon="back" label="Volver a la lista" onClick={onBack}/>;
  if (read.failure) return <><div className="actions central-actions">{back}</div><QuotesProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <><div className="actions central-actions">{back}</div><Loading label="Leyendo el presupuesto" lines={5}/></>;
  const q = read.data;
  return <RecordLayout titleId="quote-title" title={`${q.number ?? 'Presupuesto'} · ${discreet ? HIDDEN : q.title ?? '—'}`}
    badges={<><StatusBadge status={q.status}/><span className="chip">De Central</span></>}
    actions={<><OpenInCentral page={`presupuestos/${id}`} discreet={discreet}/>{back}</>}>
    {said && <p className="ok-note" role="status">{said}</p>}
    {discreet ? <p className="muted">En modo discreto no se abren documentos.</p> : <div className="central-wide"><DocumentButtons id={id}/></div>}
    <Body q={q} discreet={discreet} phases={<Phases q={q} discreet={discreet} canWrite={can.quotes} onSaid={setSaid}/>}/>
    {!discreet && !can.quotes && can.quotesProblem && q.phases.length > 0 && <p className="muted">{can.quotesProblem}</p>}
    <p className="muted">Enviar el presupuesto, cambiar su estado o sus partidas se hace en Central.</p>
  </RecordLayout>;
}
