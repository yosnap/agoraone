import { useState, type ReactNode } from 'react';
import { ActionButton } from '../ui/action-button';
import { ModernSelect } from '../ui/modern-select';
import './sync.css';

/** One row of a list to send to another app: what it is (name, client, kind, state), why it is here and, when it can
 * go, a box to tick. `editableName`: the name may be changed once ticked (a proposal of a new client). */
export type SyncRow = {
  key: string; name: string; client?: string | null; kind?: string | null; status?: string | null; detail?: string | null;
  changes?: string[]; selectable: boolean; dismissed?: boolean; editableName?: boolean; dismissable?: boolean;
};
export type SyncGroup = { id: string; label: string; hint: string; rows: SyncRow[] };
export type SyncItem = { key: string; name?: string };

const ALL = '';
const optionsOf = (rows: SyncRow[], field: 'kind' | 'status', all: string) =>
  [{ value: ALL, label: all }, ...[...new Set(rows.map(r => r[field]).filter((v): v is string => Boolean(v)))].sort().map(v => ({ value: v, label: v }))];

/** The shared table of «Desde Central» (CRMDev) and «Por crear» (Central): one group at a time with its count, a
 * search, filters by kind and state when the group has them, a box per row and one for everything shown, and a bar
 * with how many are ticked and the button that opens the exact review. Nothing is sent from here. In discreet mode
 * it is only seen: no boxes, no buttons. */
export function SyncTable({ groups, discreet, busy, reviewLabel, onReview, onDismiss, tools, empty }: {
  groups: SyncGroup[]; discreet: boolean; busy: boolean; reviewLabel: string; onReview: (items: SyncItem[]) => void;
  onDismiss?: (row: SyncRow) => void; tools?: ReactNode; empty: string;
}) {
  const shownGroups = groups.filter(g => g.rows.length > 0);
  const [groupId, setGroupId] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const group = shownGroups.find(g => g.id === groupId) ?? shownGroups[0];
  const words = query.trim().toLocaleLowerCase('es');
  const rows = (group?.rows ?? []).filter(r => (!words || `${r.name} ${r.client ?? ''}`.toLocaleLowerCase('es').includes(words))
    && (!kind || r.kind === kind) && (!status || r.status === status));
  const every = groups.flatMap(g => g.rows);
  const chosen = every.filter(r => ticked.has(r.key) && r.selectable && !r.dismissed);
  const can = !discreet;
  const selectable = rows.filter(r => r.selectable && !r.dismissed);
  const allShown = selectable.length > 0 && selectable.every(r => ticked.has(r.key));
  const toggle = (key: string) => setTicked(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleShown = () => setTicked(current => {
    const next = new Set(current);
    for (const r of selectable) if (allShown) next.delete(r.key); else next.add(r.key);
    return next;
  });
  const hasKind = (group?.rows ?? []).some(r => r.kind);
  const hasStatus = (group?.rows ?? []).some(r => r.status);
  const hasClient = (group?.rows ?? []).some(r => r.client);
  const review = () => onReview(chosen.map(r => {
    const name = names[r.key]?.trim();
    return r.editableName && name && name !== r.name ? { key: r.key, name } : { key: r.key };
  }));
  const pick = (id: string) => { setGroupId(id); setKind(ALL); setStatus(ALL); };

  return <div className="sync">
    <div className="sync-bar">
      {shownGroups.length > 0 && <div className="segmented sync-groups" role="group" aria-label="Qué ver">{shownGroups.map(g =>
        <button key={g.id} type="button" aria-pressed={group?.id === g.id} onClick={() => pick(g.id)}>{g.label} · {g.rows.length}</button>)}</div>}
      <span className="actions sync-tools">{tools}</span>
    </div>
    {!group ? <p className="muted">{empty}</p> : <>
      <p className="muted sync-hint">{group.hint}</p>
      <div className="sync-filters">
        <label className="field sync-search">Buscar<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre o cliente"/></label>
        {hasKind && <label className="field">Tipo<ModernSelect value={kind} onChange={setKind} options={optionsOf(group.rows, 'kind', 'Todos los tipos')}/></label>}
        {hasStatus && <label className="field">Estado<ModernSelect value={status} onChange={setStatus} options={optionsOf(group.rows, 'status', 'Todos los estados')}/></label>}
      </div>
      {can && <div className="sync-selection" role="status">
        <span>{chosen.length ? `${chosen.length} ${chosen.length === 1 ? 'marcado' : 'marcados'}` : 'Marca los que quieras'}</span>
        {chosen.length > 0 && <button type="button" className="button" onClick={() => setTicked(new Set())}>Quitar marcas</button>}
        <ActionButton icon="send" label={`${reviewLabel} (${chosen.length})`} tone="primary" disabled={busy || !chosen.length} onClick={review}/>
      </div>}
      {rows.length === 0 ? <p className="muted">Nada con esos filtros.</p>
        : <div className="sync-scroll"><table className="data-table sync-table">
          <thead><tr>
            {can && <th className="sync-check"><input type="checkbox" aria-label="Marcar todo lo que se ve" checked={allShown} disabled={!selectable.length} onChange={toggleShown}/></th>}
            <th>Nombre</th>{hasClient && <th>Cliente</th>}{hasKind && <th>Tipo</th>}{hasStatus && <th>Estado</th>}<th>Detalle</th>
            {can && onDismiss && <th><span className="visually-hidden">Acciones</span></th>}
          </tr></thead>
          <tbody>{rows.map(r => <tr key={r.key} className={r.dismissed ? 'sync-dismissed' : undefined}>
            {can && <td className="sync-check">{r.selectable && !r.dismissed && <input type="checkbox" aria-label={`Marcar «${r.name}»`} checked={ticked.has(r.key)} onChange={() => toggle(r.key)}/>}</td>}
            <td className="sync-name">{can && r.editableName && ticked.has(r.key)
              ? <input type="text" className="sync-name-input" aria-label={`Nombre de «${r.name}»`} value={names[r.key] ?? r.name} maxLength={120}
                onChange={event => setNames(current => ({ ...current, [r.key]: event.target.value }))}/>
              : <strong>{r.name}</strong>}</td>
            {hasClient && <td>{r.client ?? '—'}</td>}
            {hasKind && <td>{r.kind ?? '—'}</td>}
            {hasStatus && <td>{r.status ?? '—'}</td>}
            <td className="sync-detail">{r.detail}{r.changes && r.changes.length > 0 && <ul className="sync-changes">{r.changes.map(c => <li key={c}>{c}</li>)}</ul>}</td>
            {can && onDismiss && <td className="central-row-actions">{r.dismissable && <ActionButton icon={r.dismissed ? 'eye' : 'close'} label={r.dismissed ? 'Volver a mostrar' : 'Descartar'}
              iconOnly small disabled={busy} title={r.dismissed ? 'Volver a mostrar' : 'Descartar (vuelve si algo cambia)'} onClick={() => onDismiss(r)}/>}</td>}
          </tr>)}</tbody>
        </table></div>}
    </>}
  </div>;
}
