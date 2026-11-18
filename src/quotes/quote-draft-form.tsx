import { useState } from 'react';
import { ApiError } from '../api/client';
import { getClients } from '../api/clients';
import { amountRange, buildDraft, clientChoices, createDraft, createdMessage, draftTotals, emptyDraft, euros, getRates, newDraftToken, type Draft, type DraftFields } from '../api/quotes';
import type { Section } from '../shell/shell-state';
import { ModernSelect } from '../ui/modern-select';
import { useCentralRead } from '../central/use-central-view';
import { QuoteItemsEditor, QuotePhasesEditor } from './quote-items-editor';
import { QuotesProblem } from './quotes-common';

const OTHER = '\u0000otro';
export const NOT_IN_CENTRAL = 'Ese cliente no está en Central: es un cliente propio de AgoraOne. Créalo antes en Central para hacerle un presupuesto.';

/** Exactly what will be created in Central, before the user confirms it. */
function DraftSummary({ draft }: { draft: Draft }) {
  const totals = draftTotals(draft);
  return <div className="quotes-summary" aria-label="Lo que se creará en Central">
    <dl className="central-facts">
      <div><dt>Cliente</dt><dd>{draft.client}</dd></div><div><dt>Título</dt><dd>{draft.title}</dd></div>
      <div><dt>Estado</dt><dd>Borrador (no se envía)</dd></div><div><dt>Validez</dt><dd>{draft.validDays} días</dd></div>
    </dl>
    <table className="data-table central-table">
      <thead><tr><th>Concepto</th><th className="num">Cantidad</th><th className="num">Precio sin IVA</th></tr></thead>
      <tbody>{draft.items.map((item, index) => <tr key={index}>
        <td><strong>{item.description}</strong>{item.details && <small className="muted quotes-text"><br/>{item.details}</small>}</td>
        <td className="num">{item.quantity.toLocaleString('es-ES')}{item.unit ? ` ${item.unit}` : ''}</td>
        <td className="num">{amountRange(item.unitPrice, item.priceMax)}</td>
      </tr>)}</tbody>
    </table>
    <dl className="central-facts quotes-totals">
      <div><dt>Base</dt><dd>{amountRange(totals.base, totals.baseMax)}</dd></div>
      <div><dt>IVA</dt><dd>{draft.vat !== undefined ? `${draft.vat} %` : 'El de los Ajustes de Central'}</dd></div>
      <div><dt>Total con IVA</dt><dd><strong>{totals.total !== null ? amountRange(totals.total, totals.totalMax) : 'Lo calcula Central con su IVA'}</strong></dd></div>
    </dl>
    {draft.phases && <p><strong>Hitos de pago:</strong> {draft.phases.map(p => `${p.name}${p.percent !== undefined ? ` (${p.percent} %)` : ''}${p.dueDate ? `, ${p.dueDate}` : ''}`).join(' · ')}</p>}
    {draft.scope && <p className="quotes-text"><strong>Alcance:</strong> {draft.scope}</p>}
    {draft.includes && <p><strong>Incluye:</strong> {draft.includes.join(' · ')}</p>}
    {draft.excludes && <p><strong>No incluye:</strong> {draft.excludes.join(' · ')}</p>}
    {draft.notes && <p className="quotes-text"><strong>Notas:</strong> {draft.notes}</p>}
  </div>;
}

/** A new draft for Central: the client from the directory, a title, lines from the rates or typed, milestones and
 * scope. «Crear en Central» first shows exactly what will be created; only «Confirmar y crear» sends it, once
 * (the form's token), always as a draft. */
export function QuoteDraftForm({ clientNames, onCreated, onCancel, onOpen }: {
  clientNames: string[]; onCreated: (message: string) => void; onCancel: () => void; onOpen: (section: Section) => void;
}) {
  const [token] = useState(newDraftToken);
  const [fields, setFields] = useState<DraftFields>(emptyDraft);
  const [choice, setChoice] = useState('');
  const [review, setReview] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const directory = useCentralRead('directorio', getClients);
  const rates = useCentralRead('tarifas', getRates);
  const choices = clientChoices(directory.data?.clients ?? [], clientNames);
  const picked = choices.find(c => c.name === choice);
  const ownOnly = Boolean(picked && !picked.usable);
  // The lines' base while typing, whatever the client and title (checked only on «Crear en Central»).
  const preview = buildDraft({ ...fields, client: 'x', title: 'x' });
  const set = (change: Partial<DraftFields>) => { setFields(previous => ({ ...previous, ...change })); setProblem(null); };
  const pick = (value: string) => { setChoice(value); set({ client: value === OTHER ? '' : value }); };
  const check = () => {
    if (ownOnly) { setProblem(NOT_IN_CENTRAL); return; }
    const built = buildDraft(fields);
    if ('problem' in built) setProblem(built.problem); else { setProblem(null); setReview(built.draft); }
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true); setProblem(null);
    try {
      onCreated(createdMessage(await createDraft(token, review)));
    } catch (error) {
      setProblem(error instanceof ApiError && error.data?.status === 'not_in_central' ? NOT_IN_CENTRAL : error instanceof Error ? error.message : 'Central no pudo crear el borrador.');
    } finally { setBusy(false); }
  };
  if (rates.failure && ['not_connected', 'forbidden', 'auth', 'off'].includes(rates.failure.kind ?? '')) {
    return <QuotesProblem failure={rates.failure} onRetry={rates.reload} onOpen={onOpen}/>;
  }
  if (review) {
    return <article className="card central-record" aria-labelledby="draft-review-title">
      <h2 id="draft-review-title">Revisa el borrador antes de crearlo</h2>
      <p className="muted">Esto es exactamente lo que se creará en Central, con el siguiente número del año. No se envía al cliente ni se cambia ninguna fase.</p>
      <DraftSummary draft={review}/>
      {problem && <p className="error" role="alert">{problem}</p>}
      <div className="actions central-actions">
        <button type="button" className="button" disabled={busy} onClick={() => setReview(null)}>Volver a editar</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void confirm()}>{busy ? 'Creando en Central…' : 'Confirmar y crear el borrador'}</button>
      </div>
    </article>;
  }
  return <form className="card central-record quotes-form" aria-labelledby="draft-title" onSubmit={event => { event.preventDefault(); check(); }}>
    <h2 id="draft-title">Nuevo borrador en Central</h2>
    <div className="field-row">
      <label className="field">Cliente de Central<ModernSelect value={choice} onChange={pick} options={[
        { value: '', label: directory.data ? 'Elige un cliente' : 'Leyendo los clientes…' },
        ...choices.map(c => ({ value: c.name, label: c.usable ? c.name : `${c.name} · solo en AgoraOne` })),
        { value: OTHER, label: 'Otro: escribir su nombre exacto en Central' }]}/></label>
      {choice === OTHER && <label className="field">Nombre exacto en Central<input value={fields.client} maxLength={200} onChange={e => set({ client: e.target.value })}/></label>}
    </div>
    {ownOnly && <p className="notice" role="status">{NOT_IN_CENTRAL}</p>}
    <label className="field">Título<input value={fields.title} maxLength={200} placeholder="Web corporativa" onChange={e => set({ title: e.target.value })}/></label>
    <QuoteItemsEditor items={fields.items} onChange={items => set({ items })} rates={rates.failure ? [] : rates.data?.rates ?? null}/>
    {rates.failure && <p className="muted">No se pudieron leer las tarifas ({rates.failure.message}); las partidas se pueden escribir a mano.</p>}
    <QuotePhasesEditor phases={fields.phases} onChange={phases => set({ phases })}/>
    <label className="field">Objeto y alcance<textarea rows={3} value={fields.scope} maxLength={10000} onChange={e => set({ scope: e.target.value })}/></label>
    <div className="field-row">
      <label className="field">Incluye (una por línea)<textarea rows={3} value={fields.includes} onChange={e => set({ includes: e.target.value })}/></label>
      <label className="field">No incluye (una por línea)<textarea rows={3} value={fields.excludes} onChange={e => set({ excludes: e.target.value })}/></label>
    </div>
    <div className="field-row">
      <label className="field">IVA (%)<input value={fields.vat} inputMode="decimal" maxLength={6} placeholder="El de Central" onChange={e => set({ vat: e.target.value })}/></label>
      <label className="field">Validez (días)<input value={fields.validDays} inputMode="numeric" maxLength={3} onChange={e => set({ validDays: e.target.value })}/></label>
    </div>
    <label className="field">Notas<textarea rows={2} value={fields.notes} maxLength={5000} onChange={e => set({ notes: e.target.value })}/></label>
    <p className="muted">Base orientativa: {'draft' in preview ? euros(draftTotals(preview.draft).base) : '—'} sin IVA.</p>
    {problem && <p className="error" role="alert">{problem}</p>}
    <div className="actions central-actions">
      <button type="button" className="button" onClick={onCancel}>Cancelar</button>
      <button type="submit" className="button primary" disabled={ownOnly}>Crear en Central</button>
    </div>
  </form>;
}
