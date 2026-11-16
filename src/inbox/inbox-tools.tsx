import type { InboxItem, InboxKind } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { kindLabels, sender } from './inbox-labels';

export type Sort = 'recent' | 'oldest' | 'sender' | 'kind';
export type View = { text: string; kind: InboxKind | 'all'; sort: Sort; perRow: 3 | 4 };

const KEY = 'agora.bandeja.vista';
export const defaultView: View = { text: '', kind: 'all', sort: 'recent', perRow: 4 };

/** The sort and the cards per row are remembered on this Mac; the search starts empty each time. */
export function readView(): View {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...defaultView, sort: ['recent', 'oldest', 'sender', 'kind'].includes(saved.sort) ? saved.sort : 'recent', perRow: saved.perRow === 3 ? 3 : 4 };
  } catch { return defaultView; }
}
export function keepView(view: View) {
  try { localStorage.setItem(KEY, JSON.stringify({ sort: view.sort, perRow: view.perRow })); } catch { /* private window */ }
}

const plain = (text: string) => text.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** The cards that match the search and the kind, in the chosen order. The search looks at the sender, the
 * address, the subject and the summary; every word must be there. */
export function arrange(items: InboxItem[], view: View): InboxItem[] {
  const words = plain(view.text).split(/\s+/).filter(Boolean);
  const found = items.filter(item => (view.kind === 'all' || item.kind === view.kind)
    && words.every(word => plain([item.from.name, item.from.address, item.subject, item.summary].filter(Boolean).join(' ')).includes(word)));
  const time = (item: InboxItem) => new Date(item.sentAt).getTime() || 0;
  const order: Record<Sort, (a: InboxItem, b: InboxItem) => number> = {
    recent: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    sender: (a, b) => sender(a).localeCompare(sender(b), 'es') || time(b) - time(a),
    kind: (a, b) => kindLabels[a.kind].localeCompare(kindLabels[b.kind], 'es') || time(b) - time(a),
  };
  return [...found].sort(order[view.sort]);
}

const sorts: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Más recientes primero' }, { value: 'oldest', label: 'Más antiguos primero' },
  { value: 'sender', label: 'Por remitente' }, { value: 'kind', label: 'Por tipo' },
];

/** Search, kind, order and how many cards per row. */
export function InboxTools({ view, onChange, kinds }: { view: View; onChange: (view: View) => void; kinds: InboxKind[] }) {
  const set = (change: Partial<View>) => { const next = { ...view, ...change }; keepView(next); onChange(next); };
  return <div className="inbox-tools" role="group" aria-label="Buscar y ordenar">
    <label className="field inbox-search">Buscar<input type="search" value={view.text} placeholder="Remitente, asunto o resumen"
      onChange={event => set({ text: event.target.value })}/></label>
    <label className="field">Tipo<ModernSelect value={view.kind} onChange={value => set({ kind: value as View['kind'] })}
      options={[{ value: 'all', label: 'Todos los tipos' }, ...kinds.map(kind => ({ value: kind, label: kindLabels[kind] }))]}/></label>
    <label className="field">Ordenar<ModernSelect value={view.sort} onChange={value => set({ sort: value as Sort })} options={sorts}/></label>
    <div className="field inbox-per-row">Por fila<div className="segmented" role="group" aria-label="Tarjetas por fila">{([3, 4] as const).map(n =>
      <button type="button" key={n} aria-pressed={view.perRow === n} onClick={() => set({ perRow: n })}>{n}</button>)}</div></div>
  </div>;
}
