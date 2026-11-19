import { useState } from 'react';
import { createClient, distinctClient, linkClient, linkClientPair, linkCrmdevClient, type ClientsDirectory, type LinkSuggestion, type VaultCard } from '../api/clients';
import { suggestionKey, suggestionText } from './clients-view';
import { ActionButton } from '../ui/action-button';

type Act = (work: () => Promise<unknown>, said: string) => void;
const levelLabels: Record<VaultCard['level'], string> = { normal: 'Normal', local_only: 'Solo en este Mac', private: 'Privada' };

/** «Son distintos» and «Enlazar» of a suggestion, whichever two sources it pairs. */
function suggestionActions(suggestion: LinkSuggestion): { distinct: () => Promise<unknown>; link: () => Promise<unknown> } {
  if ('localId' in suggestion && 'centralId' in suggestion) {
    return { distinct: () => distinctClient(suggestion.localId, suggestion.centralId), link: () => linkClient(suggestion.localId, suggestion.centralId) };
  }
  if ('localId' in suggestion) {
    return { distinct: () => linkCrmdevClient(suggestion.localId, suggestion.crmdevId, 'distinct'),
      link: () => linkCrmdevClient(suggestion.localId, suggestion.crmdevId, 'linked') };
  }
  return { distinct: () => linkClientPair(suggestion.centralId, suggestion.crmdevId, 'distinct'),
    link: () => linkClientPair(suggestion.centralId, suggestion.crmdevId, 'linked') };
}

/** Names that are only alike between two sources: linked only on «Enlazar»; «Son distintos» is kept per pair. */
export function ClientSuggestions({ suggestions, busy, act }: { suggestions: LinkSuggestion[]; busy: boolean; act: Act }) {
  if (!suggestions.length) return null;
  return <ul className="install-list" aria-label="Posibles clientes repetidos">{suggestions.map(suggestion => {
    const actions = suggestionActions(suggestion);
    return <li key={suggestionKey(suggestion)} className="install-row">
      <span>{suggestionText(suggestion)}</span>
      <span className="actions">
        <button type="button" className="button" disabled={busy} onClick={() => act(actions.distinct, 'Se quedan como clientes distintos.')}>Son distintos</button>
        <ActionButton icon="link" label="Enlazar" tone="primary" disabled={busy} onClick={() => act(actions.link, 'Enlazados: se ven como un solo cliente.')}/>
      </span>
    </li>;
  })}</ul>;
}

/** The pairs of Central and CRMDev the user said are different, undoable (then they may be suggested again). */
export function DistinctPairs({ pairs, busy, act }: { pairs: ClientsDirectory['distinctPairs']; busy: boolean; act: Act }) {
  if (!pairs.length) return null;
  return <details className="client-pairs"><summary>Distintos entre Central y CRMDev ({pairs.length})</summary>
    <ul className="install-list">{pairs.map(pair => <li key={`${pair.centralId}-${pair.crmdevId}`} className="install-row">
      <span>«{pair.centralName ?? 'un cliente de Central que ya no se ve'}» de Central y «{pair.crmdevName ?? 'un cliente de CRMDev que ya no se ve'}» de CRMDev.</span>
      <span className="actions"><button type="button" className="button" disabled={busy}
        onClick={() => act(() => linkClientPair(pair.centralId, pair.crmdevId, 'undistinct'), 'Deshecho: pueden volver a sugerirse.')}>Deshacer</button></span>
    </li>)}</ul></details>;
}

/** The vault's «Clientes/<Nombre>» cards without a client (found by their names only, never read): «Crear cliente
 * manual» with that name, after confirming; the card in the vault is never written, moved nor renamed. */
export function VaultCards({ cards, discreet, busy, act }: { cards: ClientsDirectory['vaultCards']; discreet: boolean; busy: boolean; act: Act }) {
  const [asking, setAsking] = useState<string | null>(null);
  if (!cards.count) return <p className="muted">Todas las fichas «Clientes/…» de tu vault tienen su cliente.</p>;
  return <div className="vault-cards">
    <p className="muted">Fichas de la carpeta «Clientes» de tu vault cuyo nombre no es ninguno de tus clientes. Solo se miran los nombres de los archivos; la ficha no se toca.
      {cards.hidden ? ` ${cards.hidden} ${cards.hidden === 1 ? 'ficha reservada no se nombra' : 'fichas reservadas no se nombran'} en modo discreto.` : ''}</p>
    <ul className="install-list" aria-label="Fichas del vault sin cliente">{cards.cards.map(card => <li key={card.name} className="install-row">
      <span>«{card.name}»{card.level !== 'normal' && <small className="muted"> · {levelLabels[card.level]}</small>}
        {card.notes > 1 && <small className="muted"> · {card.notes} notas</small>}</span>
      {discreet ? null : asking === card.name
        ? <span className="actions" role="group" aria-label={`Confirmar crear ${card.name}`}>
          <small>Se crea el cliente manual «{card.name}» en AgoraOne, sin ubicar hasta que lo crees o enlaces en Central o CRMDev.</small>
          <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={() => setAsking(null)}/>
          <ActionButton icon="plus" label="Crear cliente manual" tone="primary" disabled={busy}
            onClick={() => { setAsking(null); act(() => createClient({ name: card.name, company: null, email: null, phone: null, taxId: null, domains: [], notes: null }),
              `«${card.name}» creado como cliente manual.`); }}/>
        </span>
        : <span className="actions"><ActionButton icon="plus" label="Crear cliente manual…" disabled={busy} onClick={() => setAsking(card.name)}/></span>}
    </li>)}</ul>
  </div>;
}
