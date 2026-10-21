import { useEffect, useRef, useState } from 'react';
import type { HermesCatalog } from '../../shared/hermes-catalog';
import type { Place } from '../data/city';
import { serviceGroups } from '../data/service-groups';
import { fold } from './fold';

/** What a place is doing now: a chat waiting for «Permitir», a chat answering, or activity recorded by Hermes. */
export type PlaceSignal = 'approval' | 'busy' | 'live';
type Props = { catalog: HermesCatalog | null; error: string; places: Place[]; selected: string | null; onSelect: (id: string) => void;
  signals: Record<string, PlaceSignal>; onOpenChat: (id: string) => void };
const signalLabels: Record<PlaceSignal, string> = { approval: 'Espera tu permiso', busy: 'Respondiendo…', live: 'Actividad ahora' };
type Group = 'profile' | 'space' | 'vault' | 'common';

const groups: { key: Group; title: string }[] = [
  { key: 'profile', title: 'Perfiles' }, { key: 'space', title: 'Proyectos' }, { key: 'vault', title: 'Vaults' }, { key: 'common', title: 'Lugares comunes' },
];
const groupOf = (place: Place): Group => place.kind === 'profile' || place.kind === 'space' || place.kind === 'vault' ? place.kind : 'common';
const subtitle = (place: Place) => place.kind === 'profile' ? 'Identidad, memoria, skills y tareas · Hermes'
  : place.kind === 'space' ? 'Espacio registrado · Hermes'
  : place.kind === 'vault' ? 'Notas de Obsidian · lectura y edición'
  : place.id === 'mcp-center' ? 'Servidores MCP de tus perfiles · conexión no comprobada'
  : 'Luma · biblioteca propia de AgoraOne';
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, [contenteditable="true"]');

/** The city's directory: every place grouped by kind, with a filter («/» focuses it, Esc clears it). */
export function CityDirectory({ catalog, error, places, selected, onSelect, signals, onOpenChat }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<Group>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || editable(event.target) || window.document.querySelector('dialog[open]')) return;
      event.preventDefault(); input.current?.focus();
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);
  const needle = fold(query.trim());
  const visible = needle ? places.filter(place => fold(`${place.name} ${subtitle(place)}`).includes(needle)) : places;
  const toggle = (key: Group, open: boolean) => setCollapsed(previous => {
    if (open === !previous.has(key)) return previous;
    const next = new Set(previous); if (open) next.delete(key); else next.add(key); return next;
  });
  return <aside className="directory">
    <div className="eyebrow">TU HERMES <span>{catalog?.profiles.length || 0} perfiles</span></div>
    <div className="catalog-status" role="status">{catalog ? <>{catalog.spaces.length} proyectos · {catalog.vaults?.length || 0} vaults · {serviceGroups(catalog).length} nombres MCP<p>Lectura: {new Date(catalog.scannedAt).toLocaleTimeString()} · actualización cada 30 s</p></> : 'Detectando instalación…'}
      {error && <p className="error">{error}</p>}
      {!!catalog?.warnings.length && <details><summary>Detalles de detección ({catalog.warnings.length})</summary>{catalog.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
    </div>
    <label className="directory-search"><span className="visually-hidden">Buscar en el directorio</span>
      <input ref={input} type="search" value={query} placeholder="Buscar perfil, vault o MCP…" aria-keyshortcuts="/" onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); if (query) setQuery(''); else event.currentTarget.blur(); } }}/>
      <kbd aria-hidden="true">/</kbd>
    </label>
    {groups.map(group => {
      const items = visible.filter(place => groupOf(place) === group.key);
      if (!items.length) return null;
      // While filtering, every group with a match stays open.
      return <details key={group.key} className="directory-group" open={!!needle || !collapsed.has(group.key)} onToggle={event => { if (!needle) toggle(group.key, event.currentTarget.open); }}>
        <summary><span>{group.title}</span><small>{items.length}</small></summary>
        {items.map(place => {
          const signal = signals[place.id];
          // A chat in progress opens straight on its conversation, where the pending «Permitir» is.
          return <button key={place.id} onClick={() => signal === 'approval' || signal === 'busy' ? onOpenChat(place.id) : onSelect(place.id)} className={`place-item ${selected === place.id ? 'chosen' : ''}`}>
            <span className={`place-dot ${signal ? `signal-${signal}` : ''}`} style={{ background: place.color }}/>
            <span><strong>{place.name}</strong><small>{subtitle(place)}</small>{signal && <em className={`place-signal signal-${signal}`}>{signalLabels[signal]}</em>}</span><span className="arrow">↗</span>
          </button>;
        })}
      </details>;
    })}
    {needle && !visible.length && <p className="directory-empty">Nada coincide con «{query.trim()}».</p>}
  </aside>;
}
