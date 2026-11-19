import type { ChatSummary, InboxItem, InboxKind, Level } from '../api/core';
import { kindLabels, sender } from './inbox-labels';

/** The Bandeja's cards from both sources, joined on the screen (the core keeps mail and WhatsApp apart). Their ids
 * are different spaces, so a card is always known by its source and id. Pure functions. */
export type Card = { source: 'mail'; item: InboxItem } | { source: 'chat'; item: ChatSummary };
export type SourceFilter = 'all' | 'mail' | 'chat';
export type Sort = 'recent' | 'oldest' | 'sender' | 'kind';
export type View = { text: string; kind: InboxKind | 'all'; source: SourceFilter; sort: Sort; perRow: 3 | 4 };

export const cardKey = (card: Card) => `${card.source}:${card.item.id}`;

/** Who a conversation is with: the participant's name, else the rule's label; a private one names nobody. */
export const chatName = (item: ChatSummary) =>
  item.confidentiality === 'private' || !item.participant ? 'Conversación privada' : item.participant.name || item.label || 'Contacto de WhatsApp';

export const cardName = (card: Card) => card.source === 'mail' ? sender(card.item) : chatName(card.item);
export const cardDate = (card: Card) => card.source === 'mail' ? card.item.sentAt : card.item.lastIncomingAt ?? card.item.updatedAt;
const time = (card: Card) => new Date(cardDate(card)).getTime() || 0;

const plain = (text: string) => text.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** What the search looks at: the sender, address, subject and summary of a mail; the participant's name, the label
 * and the summary of a conversation (never its number). */
const searched = (card: Card) => card.source === 'mail'
  ? [card.item.from.name, card.item.from.address, card.item.subject, card.item.summary]
  : [card.item.confidentiality === 'private' ? null : card.item.participant?.name, card.item.label, card.item.summary];

/** The cards that match the source, the search and the kind, in the chosen order; every word must be there. */
export function arrange(cards: Card[], view: View): Card[] {
  const words = plain(view.text).split(/\s+/).filter(Boolean);
  const found = cards.filter(card => (view.source === 'all' || card.source === view.source) && (view.kind === 'all' || card.item.kind === view.kind)
    && words.every(word => plain(searched(card).filter(Boolean).join(' ')).includes(word)));
  const order: Record<Sort, (a: Card, b: Card) => number> = {
    recent: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    sender: (a, b) => cardName(a).localeCompare(cardName(b), 'es') || time(b) - time(a),
    kind: (a, b) => kindLabels[a.item.kind].localeCompare(kindLabels[b.item.kind], 'es') || time(b) - time(a),
  };
  return [...found].sort(order[view.sort]);
}

/** The first date a card mentions that is not past, when it reads as one (the form shows it to be checked). */
const asDate = (text: string) => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());  // a day alone is the user's own day, at 9:00 (not UTC midnight)
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 9, 0) : new Date(text);
};
export const firstDate = (details: { dates?: string[] }) =>
  details.dates?.map(asDate).find(d => !Number.isNaN(d.getTime()) && d.getTime() > Date.now() - 86400000);

const attachmentNames: Record<string, [string, string]> = {
  image: ['imagen', 'imágenes'], audio: ['audio', 'audios'], voice: ['nota de voz', 'notas de voz'], video: ['vídeo', 'vídeos'],
  document: ['documento', 'documentos'], file: ['archivo', 'archivos'], sticker: ['sticker', 'stickers'], location: ['ubicación', 'ubicaciones'],
  contact: ['contacto', 'contactos'], contacts: ['contacto', 'contactos'],
};
/** An attachment's kind as the card says it («imagen»), never a link. */
export const attachmentName = (kind: string, count = 1) => {
  const [one, many] = attachmentNames[kind.toLowerCase()] ?? ['adjunto', 'adjuntos'];
  return count === 1 ? one : many;
};
/** «2 imágenes, 1 audio»: each kind and how many; empty when there are none. */
export const attachmentsText = (counts: Record<string, number>) =>
  Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${attachmentName(kind, n)}`).join(', ');

/** What a card's actions (note, event, issue, Orca) need of it, whichever its source: the kind and id they are
 * checked by in the core, and the words of the note. A conversation gives its participant's name, never the number. */
export type CardOrigin = {
  kind: 'mail' | 'chat'; id: number; subject: string | null; sentAt: string; from: { name: string | null; address: string | null };
  summary: string | null; asks?: string[]; confidentiality: Level; client: { name: string; projects: string[] } | null; attachments: Record<string, number>;
};
export const mailOrigin = (item: InboxItem): CardOrigin => ({
  kind: 'mail', id: item.id, subject: item.subject, sentAt: item.sentAt, from: item.from, summary: item.summary, asks: item.details.asks,
  confidentiality: item.confidentiality, client: item.client, attachments: {},
});
export const chatOrigin = (item: ChatSummary): CardOrigin => ({
  kind: 'chat', id: item.id, subject: `WhatsApp con ${chatName(item)}`, sentAt: item.lastIncomingAt ?? item.updatedAt,
  from: { name: chatName(item), address: null }, summary: item.summary, asks: item.details.asks, confidentiality: item.confidentiality,
  client: item.client, attachments: item.attachments,
});
