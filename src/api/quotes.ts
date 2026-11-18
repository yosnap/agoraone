import { request } from './client';

// The «Presupuestos» module, through the core (/api/core/quotes*): Central's quotes and rates read live with a key
// that has the «presupuestos» permission. The core copies only what is shown here; it downloads and opens a
// quote's PDF or Word itself (the screen never gets Central's address nor its key) and creates a new quote only
// as a draft, exactly as confirmed, once per form.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type PhaseStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'INVOICED';
export type QuoteRow = { id: string | null; number: string | null; title: string | null; client: string | null; status: QuoteStatus | null;
  issuedAt: string | null; validUntil: string | null; total: number | null; totalMax: number | null };
export type QuoteItem = { description: string | null; details: string | null; quantity: number | null; unit: string | null; unitPrice: number | null; priceMax: number | null };
export type QuotePhase = { name: string | null; percent: number | null; amount: number | null; dueDate: string | null; status: PhaseStatus | null; completedAt: string | null };
export type QuoteRecord = Omit<QuoteRow, 'client'> & {
  client: { id: string | null; name: string | null } | null; project: { id: string | null; name: string | null } | null;
  vat: number | null; notes: string | null; scope: string | null; includes: string[]; excludes: string[]; assumptions: string[];
  thirdPartyCosts: string | null; schedule: { when: string | null; what: string | null }[]; items: QuoteItem[]; phases: QuotePhase[];
  base: number | null; tax: number | null; baseMax: number | null;
};
export type Rate = { id: string | null; name: string | null; unit: string | null; price: number | null };
export type QuoteFilters = { cliente?: string; estado?: string };
export type DocumentFormat = 'pdf' | 'docx';

/** What goes to Central for a new draft: Central's own `createQuoteSchema`, nothing more. */
export type DraftItem = { description: string; details?: string; unitPrice: number; priceMax?: number; quantity: number; unit?: string };
export type DraftPhase = { name: string; percent?: number; dueDate?: string };
export type Draft = { client: string; title: string; items: DraftItem[]; phases?: DraftPhase[]; scope?: string; includes?: string[]; excludes?: string[];
  vat?: number; notes?: string; validDays: number };
export type CreatedQuote = { id?: string | null; number?: string | null; client?: string };

export function getQuotes(filters: QuoteFilters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return core<{ quotes: QuoteRow[] }>(`/quotes${query ? `?${query}` : ''}`);
}
export const getQuote = (id: string) => core<QuoteRecord>(`/quotes/${encodeURIComponent(id)}`);
export const getRates = () => core<{ rates: Rate[] }>('/quotes/rates');
/** The core downloads the document from Central and opens it with the system's program. */
export const openQuoteDocument = (id: string, format: DocumentFormat) =>
  core<{ opened: string; format: DocumentFormat }>(`/quotes/${encodeURIComponent(id)}/open?format=${format}`, {});
/** Creates the draft in Central; `token` is the form's own, so a second send never creates another one. */
export const createDraft = (token: string, quote: Draft) => core<{ created: CreatedQuote; repeated?: boolean }>('/quotes', { token, quote });

export const quoteStatusLabels: Record<QuoteStatus, string> = { DRAFT: 'Borrador', SENT: 'Enviado', ACCEPTED: 'Aceptado', REJECTED: 'Rechazado', EXPIRED: 'Caducado' };
export const quoteStatusTone: Record<QuoteStatus, string> = { DRAFT: 'neutral', SENT: 'waiting', ACCEPTED: 'good', REJECTED: 'bad', EXPIRED: 'waiting' };
export const phaseStatusLabels: Record<PhaseStatus, string> = { PENDING: 'Pendiente', IN_PROGRESS: 'En curso', DONE: 'Hecha', INVOICED: 'Facturada' };

export const MAX_AMOUNT = 99_999_999.99;
const money = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const euros = (value: number | null | undefined) => (value == null ? '—' : money.format(value));
/** «1.210,00 €» or «1.210,00 € – 2.420,00 €» for a range. */
export const amountRange = (from: number | null | undefined, to: number | null | undefined) =>
  to != null && from != null && to > from ? `${euros(from)} – ${euros(to)}` : euros(from);

/** An amount typed in Spanish («1.234,56», «900», «12.5») in euros with at most two decimals; null if it is not one. */
export function parseAmount(typed: string): number | null {
  let text = typed.trim().replace(/\s|€/g, '');
  if (!text) return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value <= MAX_AMOUNT ? value : null;
}

/** A new token for a draft form (one per form: a double click or a repeated send creates one draft). */
export const newDraftToken = () => crypto.randomUUID();

/** What the user typed in the form, before it is a draft. */
export type ItemFields = { description: string; details: string; quantity: string; unit: string; unitPrice: string; priceMax: string };
export type PhaseFields = { name: string; percent: string; dueDate: string };
export type DraftFields = { client: string; title: string; items: ItemFields[]; phases: PhaseFields[]; scope: string; includes: string; excludes: string;
  vat: string; validDays: string; notes: string };

export const emptyItem = (): ItemFields => ({ description: '', details: '', quantity: '1', unit: '', unitPrice: '', priceMax: '' });
export const emptyPhase = (): PhaseFields => ({ name: '', percent: '', dueDate: '' });
export const emptyDraft = (): DraftFields => ({ client: '', title: '', items: [emptyItem()], phases: [], scope: '', includes: '', excludes: '', vat: '', validDays: '30', notes: '' });
/** A line from one of Central's rates: its name, unit and price without VAT. */
export const itemFromRate = (rate: Rate): ItemFields => ({ ...emptyItem(), description: rate.name ?? '', unit: rate.unit ?? '',
  unitPrice: rate.price != null ? String(rate.price).replace('.', ',') : '' });

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day
  && +day.slice(0, 4) >= 2000 && +day.slice(0, 4) <= 2100;

/** The draft exactly as it will go to Central, or the first thing to fix, with the same limits as Central. */
export function buildDraft(fields: DraftFields): { draft: Draft } | { problem: string } {
  const client = fields.client.trim();
  const title = fields.title.trim();
  if (!client) return { problem: 'Elige el cliente.' };
  if (!title) return { problem: 'Escribe el título del presupuesto.' };
  if (title.length > 200) return { problem: 'El título tiene como mucho 200 caracteres.' };
  const items: DraftItem[] = [];
  for (const [index, item] of fields.items.entries()) {
    const n = index + 1;
    const description = item.description.trim();
    if (!description) return { problem: `Escribe el concepto de la partida ${n}.` };
    if (description.length > 500 || item.details.trim().length > 3000 || item.unit.trim().length > 30) return { problem: `La partida ${n} es demasiado larga.` };
    const unitPrice = parseAmount(item.unitPrice);
    if (unitPrice === null) return { problem: `El precio de la partida ${n} no es un importe válido (por ejemplo, 1.200,50).` };
    const quantity = parseAmount(item.quantity || '1');
    if (quantity === null) return { problem: `La cantidad de la partida ${n} no es válida.` };
    const priceMax = item.priceMax.trim() ? parseAmount(item.priceMax) : undefined;
    if (priceMax === null) return { problem: `El precio máximo de la partida ${n} no es un importe válido.` };
    if (priceMax !== undefined && priceMax < unitPrice) return { problem: `El precio máximo de la partida ${n} es menor que su precio.` };
    items.push({ description, ...(item.details.trim() ? { details: item.details.trim() } : {}), unitPrice, ...(priceMax !== undefined ? { priceMax } : {}),
      quantity, ...(item.unit.trim() ? { unit: item.unit.trim() } : {}) });
  }
  if (!items.length) return { problem: 'Añade al menos una partida.' };
  if (items.length > 100) return { problem: 'Como mucho 100 partidas.' };
  const phases: DraftPhase[] = [];
  for (const [index, phase] of fields.phases.entries()) {
    const name = phase.name.trim();
    if (!name) return { problem: `Escribe el nombre del hito ${index + 1}.` };
    const percent = phase.percent.trim() ? parseAmount(phase.percent) : undefined;
    if (percent === null || (percent !== undefined && percent > 100)) return { problem: `El porcentaje del hito ${index + 1} va de 0 a 100.` };
    if (phase.dueDate && !validDay(phase.dueDate)) return { problem: `La fecha del hito ${index + 1} no es válida.` };
    phases.push({ name: name.slice(0, 200), ...(percent !== undefined ? { percent } : {}), ...(phase.dueDate ? { dueDate: phase.dueDate } : {}) });
  }
  if (phases.length > 50) return { problem: 'Como mucho 50 hitos.' };
  const vat = fields.vat.trim() ? parseAmount(fields.vat) : undefined;
  if (vat === null || (vat !== undefined && vat > 100)) return { problem: 'El IVA va de 0 a 100 %.' };
  const validDays = Number(fields.validDays.trim() || '30');
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) return { problem: 'La validez va de 1 a 365 días.' };
  const includes = lines(fields.includes), excludes = lines(fields.excludes);
  if (includes.length > 50 || excludes.length > 50 || [...includes, ...excludes].some(line => line.length > 1000)) return { problem: 'Las listas tienen como mucho 50 líneas de 1000 caracteres.' };
  const scope = fields.scope.trim(), notes = fields.notes.trim();
  if (scope.length > 10000 || notes.length > 5000) return { problem: 'El alcance o las notas son demasiado largos.' };
  return { draft: { client, title, items, ...(phases.length ? { phases } : {}), ...(scope ? { scope } : {}), ...(includes.length ? { includes } : {}),
    ...(excludes.length ? { excludes } : {}), ...(vat !== undefined ? { vat } : {}), ...(notes ? { notes } : {}), validDays } };
}

const cents = (value: number) => Math.round(value * 100) / 100;
/** Base (and its highest when some price is a range) and, when the VAT is given, tax and total, as Central adds them. */
export function draftTotals(draft: Draft) {
  const base = cents(draft.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
  const baseMax = cents(draft.items.reduce((sum, i) => sum + (i.priceMax ?? i.unitPrice) * i.quantity, 0));
  const withVat = (value: number) => (draft.vat === undefined ? null : cents(value * (1 + draft.vat / 100)));
  return { base, baseMax: baseMax > base ? baseMax : null, total: withVat(base), totalMax: baseMax > base ? withVat(baseMax) : null };
}

/** The key of a quotes list in the shared store of Central's reads (forgotten by «Volver a leer»). */
export const quotesKey = (filters: QuoteFilters = {}) => `presupuestos?cliente=${filters.cliente ?? ''}&estado=${filters.estado ?? ''}`;

export type ClientChoice = { name: string; usable: boolean };

/** The clients a draft can be for: Central's from the directory (also the ones linked to a client kept here) and the
 * ones of the quotes already made; a client only kept in AgoraOne is listed but cannot be used. */
export function clientChoices(directory: { name: string; source: string }[], fromQuotes: string[]): ClientChoice[] {
  const byName = new Map<string, ClientChoice>();
  for (const entry of directory) {
    const key = entry.name.toLocaleLowerCase('es');
    const usable = entry.source !== 'local' || Boolean(byName.get(key)?.usable);
    byName.set(key, { name: byName.get(key)?.name ?? entry.name, usable });
  }
  for (const name of fromQuotes) {
    const key = name.toLocaleLowerCase('es');
    byName.set(key, { name: byName.get(key)?.name ?? name, usable: true });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
