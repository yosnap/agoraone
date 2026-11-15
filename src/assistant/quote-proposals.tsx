import { useState } from 'react';
import { createQuoteFromProposal, dismissProposal, type ProposedQuote } from '../api/core';

type QuoteProposal = { id: string; quote: ProposedQuote; state: 'open' | 'busy' | 'made' | 'dismissed'; result?: string };
const euros = (value: number) => value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/** Quotes Watson prepared (1.7): shown whole (lines, base, VAT and total) and created in Central as a draft
 * only with «Crear en Central»; they are sent and followed from Central. */
export function useQuoteProposals() {
  const [list, setList] = useState<QuoteProposal[]>([]);
  const settle = (id: string, change: Partial<QuoteProposal>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const create = async (proposal: QuoteProposal) => {
    settle(proposal.id, { state: 'busy' });
    try {
      const { created } = await createQuoteFromProposal(proposal.id);
      settle(proposal.id, { state: 'made', result: `Presupuesto${created.number ? ` ${created.number}` : ''} creado en Central como borrador: revísalo y envíalo desde allí.` });
    } catch (failure) { settle(proposal.id, { state: 'dismissed', result: failure instanceof Error ? failure.message : 'Central no pudo crearlo.' }); }
  };
  const dismiss = (proposal: QuoteProposal) => { settle(proposal.id, { state: 'dismissed', result: 'Presupuesto descartado: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  return { list, create, dismiss, add: (id: string, quote: ProposedQuote) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, quote, state: 'open' }]), clear: () => setList([]) };
}

export function QuoteProposals({ state }: { state: ReturnType<typeof useQuoteProposals> }) {
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => {
    const { quote } = proposal;
    const base = quote.items.reduce((sum, item) => sum + item.unitPrice * (item.quantity || 1), 0);
    const vat = quote.vat ?? 21;
    return <article key={proposal.id} className="card note-proposal" aria-label="Presupuesto propuesto">
      <strong>Presupuesto propuesto: {quote.title}</strong>
      <small>Para {quote.client}{quote.validDays ? ` · válido ${quote.validDays} días` : ''}</small>
      <table className="work-table quote-table"><thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio sin IVA</th></tr></thead>
        <tbody>{quote.items.map((item, n) => <tr key={n}><td>{item.description}{item.details && <><br/><small className="muted">{item.details}</small></>}</td>
          <td>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</td><td>{euros(item.unitPrice)}{item.priceMax ? ` – ${euros(item.priceMax)}` : ''}</td></tr>)}</tbody></table>
      <small>Base {euros(base)} · IVA {vat} % {quote.vat === undefined ? '(el de Central)' : ''} · Total {euros(base * (1 + vat / 100))}{quote.items.some(i => i.priceMax) ? ' (desde)' : ''}</small>
      {quote.phases?.length ? <small className="muted">Pagos: {quote.phases.map(p => `${p.name}${p.percent !== undefined ? ` ${p.percent} %` : ''}`).join(' · ')}</small> : null}
      {proposal.state === 'open' || proposal.state === 'busy' ? <div className="inbox-actions">
        <button type="button" className="button primary" disabled={proposal.state === 'busy'} onClick={() => void state.create(proposal)}>{proposal.state === 'busy' ? 'Creando en Central…' : 'Crear en Central (borrador)'}</button>
        <button type="button" className="button" onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div> : null}
      {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
    </article>;
  })}</>;
}
