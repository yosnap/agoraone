import type { InboxKind } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { ActionIcon } from '../ui/action-icons';
import type { Sort, SourceFilter, View } from './inbox-cards';
import { kindLabels } from './inbox-labels';

const KEY = 'agora.bandeja.vista';
export const defaultView: View = { text: '', kind: 'all', source: 'all', sort: 'recent', perRow: 4 };

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

const sorts: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Más recientes primero' }, { value: 'oldest', label: 'Más antiguos primero' },
  { value: 'sender', label: 'Por remitente' }, { value: 'kind', label: 'Por tipo' },
];

const sources: { value: SourceFilter; label: string }[] = [{ value: 'all', label: 'Todas' }, { value: 'mail', label: 'Correo' }, { value: 'chat', label: 'WhatsApp' }];

/** Mail or WhatsApp at a glance: the same icon in the source switch and on each card. */
export function SourceIcon({ source }: { source: 'mail' | 'chat' }) {
  return <ActionIcon name={source === 'chat' ? 'whatsapp' : 'mail'} className={`source-icon source-icon-${source}`}/>;
}

/** The source switch shown next to the scopes: all, mail only or WhatsApp only, each with its icon and count. */
export function SourceSwitch({ value, onChange, counts }: { value: SourceFilter; onChange: (value: SourceFilter) => void; counts: Record<SourceFilter, number> }) {
  return <div className="segmented inbox-sources" role="group" aria-label="Fuente">{sources.map(source =>
    <button key={source.value} type="button" aria-pressed={value === source.value} onClick={() => onChange(source.value)}>
      {source.value !== 'all' && <SourceIcon source={source.value}/>}{source.label} · {counts[source.value]}</button>)}</div>;
}

/** Search, kind, order and how many cards per row; the source switch sits with the scopes. */
export function InboxTools({ view, onChange, kinds, chat = false }: { view: View; onChange: (view: View) => void; kinds: InboxKind[]; chat?: boolean }) {
  const set = (change: Partial<View>) => { const next = { ...view, ...change }; keepView(next); onChange(next); };
  return <div className="inbox-tools" role="group" aria-label="Buscar y ordenar">
    <label className="field inbox-search">Buscar<input type="search" value={view.text} placeholder={chat ? 'Remitente, contacto, asunto o resumen' : 'Remitente, asunto o resumen'}
      onChange={event => set({ text: event.target.value })}/></label>
    <label className="field">Tipo<ModernSelect value={view.kind} onChange={value => set({ kind: value as View['kind'] })}
      options={[{ value: 'all', label: 'Todos los tipos' }, ...kinds.map(kind => ({ value: kind, label: kindLabels[kind] }))]}/></label>
    <label className="field">Ordenar<ModernSelect value={view.sort} onChange={value => set({ sort: value as Sort })} options={sorts}/></label>
    <div className="field inbox-per-row">Por fila<div className="segmented" role="group" aria-label="Tarjetas por fila">{([3, 4] as const).map(n =>
      <button type="button" key={n} aria-pressed={view.perRow === n} onClick={() => set({ perRow: n })}>{n}</button>)}</div></div>
  </div>;
}
