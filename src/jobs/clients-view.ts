import type { ClientsDirectory, DirectoryClient, LinkSuggestion } from '../api/clients';

// What the directory of clients shows, without React: the filter, the counts of the header and the sentence of each
// suggestion of links between the three sources (Central, CRMDev and the clients kept in AgoraOne).

export type ClientsFilter = 'all' | 'unplaced' | 'cards';

export function filterClients(clients: DirectoryClient[], filter: ClientsFilter): DirectoryClient[] {
  return filter === 'unplaced' ? clients.filter(client => client.unplaced) : clients;
}

/** «3 sin ubicar · 2 fichas sin cliente», or nothing when there is nothing to follow. */
export function followUp(data: Pick<ClientsDirectory, 'unplacedCount' | 'vaultCards'>): string {
  const parts = [];
  if (data.unplacedCount) parts.push(`${data.unplacedCount} sin ubicar`);
  if (data.vaultCards.count) parts.push(`${data.vaultCards.count} ${data.vaultCards.count === 1 ? 'ficha' : 'fichas'} sin cliente`);
  return parts.join(' · ');
}

/** Which sources a suggestion pairs, and its question. */
export function suggestionText(suggestion: LinkSuggestion): string {
  if ('localId' in suggestion && 'centralId' in suggestion) return `¿Tu cliente «${suggestion.localName}» es el mismo que «${suggestion.centralName}» de Central?`;
  if ('localId' in suggestion) return `¿Tu cliente «${suggestion.localName}» es el mismo que «${suggestion.crmdevName}» de CRMDev?`;
  return `¿«${suggestion.centralName}» de Central es el mismo cliente que «${suggestion.crmdevName}» de CRMDev?`;
}

export const suggestionKey = (suggestion: LinkSuggestion) =>
  ['localId' in suggestion ? suggestion.localId : '', 'centralId' in suggestion ? suggestion.centralId : '', 'crmdevId' in suggestion ? suggestion.crmdevId : ''].join('-');

/** «En CRMDev: …» for each field CRMDev has otherwise than Central; an address only says that it differs. */
export function differenceText(difference: DirectoryClient['differences'][number]): string {
  return difference.crmdev ? `${difference.label} en CRMDev: ${difference.crmdev}` : `${difference.label}: distinto en CRMDev (míralo allí)`;
}

/** Where a client kept here may still be created: each CRM it is not in, connected and able to create. */
export function placements(client: DirectoryClient, can: { central: boolean; crmdev: boolean }): ('central' | 'crmdev')[] {
  if (client.localId === null) return [];
  return (['central', 'crmdev'] as const).filter(where => can[where] && !client.sources.includes(where));
}

/** What may be on screen in discreet mode, at once (before the core is asked again): only normal vault cards are
 * named; the reserved ones are counted. */
export function forDiscreet(cards: ClientsDirectory['vaultCards'], discreet: boolean): ClientsDirectory['vaultCards'] {
  if (!discreet) return cards;
  const shown = cards.cards.filter(card => card.level === 'normal');
  return { ...cards, cards: shown, hidden: cards.hidden + cards.cards.length - shown.length };
}

/** Why a client kept here is «sin ubicar» again: the CRM it was linked with no longer returns that client. */
export const staleText = (stale: DirectoryClient['staleLink']) =>
  stale ? `Estaba enlazado con un cliente de ${stale === 'central' ? 'Central' : 'CRMDev'} que ya no aparece al leerlo (borrado o fuera de lo leído): vuelve a ubicarlo.` : '';
