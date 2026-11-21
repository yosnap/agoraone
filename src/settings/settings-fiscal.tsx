import { useRef, useState } from 'react';
import {
  addFiscalFolder, applyFolderPlan, changeFiscalFolder, chooseFiscalFolder, getFiscalFolders, getFiscalReading, getFolderPlan, getScopes, putFiscalReading, removeFiscalFolder,
  type FiscalFolder, type FolderKind, type FolderPlan, type Scope,
} from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { hereLabel } from '../ui/platform';
import { FolderLogo } from './provider-logos';
import { ActionButton } from '../ui/action-button';

export const kindLabels: Record<FolderKind, string> = { autonomo: 'Autónomo', empresa: 'Empresa', personal: 'Personal' };
const kinds = (Object.keys(kindLabels) as FolderKind[]).map(value => ({ value, label: kindLabels[value] }));
const structure: Record<FolderKind, string> = {
  autonomo: 'Facturas Entrantes|Salientes/año/trimestre', empresa: 'Facturas Entrantes|Salientes/año/trimestre', personal: 'Gastos|Compras/año',
};

/** A folder on another drive or a network share: AgoraOne checks every move, but if someone else can write there
 * at the same time, a file could be swapped while it is being filed. */
const SHARED_NOTICE = 'Está fuera de tu carpeta personal. Úsala solo si únicamente tú puedes escribir en ella: si otras personas o equipos también pueden, alguien podría cambiar un archivo justo mientras AgoraOne lo archiva.';

/** The fiscal folders: where invoices and receipts are filed, each with a name, a kind and the scope whose
 * mail it receives. Chosen with the macOS folder picker; AgoraOne never touches anything outside them. */
export function FiscalSettingsCard() {
  const [folders, setFolders] = useState<FiscalFolder[] | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [draft, setDraft] = useState<{ path: string; name: string; kind: FolderKind; scopeId: string } | null>(null);
  const [plan, setPlan] = useState<{ folder: number; plan: FolderPlan } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [withClaude, setWithClaude] = useState<boolean | null>(null);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getFiscalReading().then(found => setWithClaude(found.withClaude)).catch(() => undefined);
    Promise.all([getFiscalFolders(), getScopes()]).then(([found, known]) => { setFolders(found.folders); setScopes(known.scopes); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las carpetas.'));
  }
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof Error ? failure.message : fallback);
  const act = async (work: () => Promise<{ folders: FiscalFolder[] }>, done: string) => {
    setError(''); setNote('');
    try { setFolders((await work()).folders); setNote(done); return true; } catch (failure) { fail(failure, 'No se pudo completar.'); return false; }
  };
  const pick = async () => {
    setError(''); setNote(''); setBusy(true);
    try {
      const { path } = await chooseFiscalFolder();
      if (path) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
        const scope = scopes.find(s => s.name.toLowerCase() === name.toLowerCase());
        setDraft({ path, name, kind: 'autonomo', scopeId: scope ? String(scope.id) : '' });
      }
    } catch (failure) { fail(failure, 'No se pudo abrir el selector.'); } finally { setBusy(false); }
  };
  const save = () => draft && void act(() => addFiscalFolder({ path: draft.path, name: draft.name.trim(), kind: draft.kind, scopeId: draft.scopeId ? Number(draft.scopeId) : null }),
    `Carpeta «${draft.name.trim()}» añadida.`).then(ok => { if (ok) setDraft(null); });
  const calculate = async (folder: number) => {
    setError(''); setNote(''); setBusy(true); setConfirming(false);
    try { setPlan({ folder, plan: await getFolderPlan(folder) }); } catch (failure) { fail(failure, 'No se pudo calcular el plan.'); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!plan) return;
    setError(''); setNote('');
    try {
      const done = await applyFolderPlan(plan.folder, plan.plan.moves);
      setNote(`${done.moved.length} archivos movidos. Copia previa en los datos de AgoraOne (${done.backup}).`); setPlan(null); setConfirming(false);
      if (done.error) setError(`${done.error} Lo ya movido queda registrado; vuelve a calcular el plan para seguir.`);
    } catch (failure) { fail(failure, 'No se pudo mover.'); }
  };
  const scopeOptions = [{ value: '', label: 'Ninguno' }, ...scopes.map(s => ({ value: String(s.id), label: s.name }))];
  return <article className="card" aria-labelledby="fiscal-title">
    <div className="card-head"><h2 id="fiscal-title">Carpetas fiscales</h2>
      {!draft && <ActionButton icon="plus" label="Añadir carpeta…" disabled={busy} onClick={() => void pick()}/>}</div>
    <p>Donde se archivan facturas y recibos. Cada una recibe lo de las cuentas de su ámbito; una regla del correo con ámbito manda sobre la cuenta, y al archivar puedes cambiarla. AgoraOne no toca nada fuera de ellas y nunca sobrescribe ni borra.</p>
    {draft && <div className="mail-new" aria-label="Nueva carpeta fiscal">
      <p className="muted"><code>{draft.path}</code></p>
      <div className="mail-account-fields">
        <label className="field">Nombre<input value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
        <label className="field">Tipo<ModernSelect value={draft.kind} options={kinds} onChange={value => setDraft({ ...draft, kind: value as FolderKind })}/></label>
        <label className="field">Ámbito<ModernSelect value={draft.scopeId} options={scopeOptions} onChange={value => setDraft({ ...draft, scopeId: value })}/></label>
      </div>
      <p className="muted">Estructura: {structure[draft.kind]}.</p>
      <div className="field-row"><ActionButton icon="save" label="Guardar carpeta" tone="primary" disabled={!draft.name.trim()} onClick={save}/>
        <ActionButton icon="close" label="Cancelar" onClick={() => setDraft(null)}/></div>
    </div>}
    {folders === null && !error ? <Loading label="Leyendo las carpetas"/> : <ul className="mail-accounts compact">
      {folders?.length === 0 && !draft && <li className="muted">Aún no hay carpetas. Pulsa «Añadir carpeta…» y elige, por ejemplo, la de tu actividad de autónomo.</li>}
      {folders?.map(folder => <li key={folder.id} className={open.has(folder.id) ? 'open' : ''}>
        <div className="compact-row">
          <button type="button" className="compact-toggle" aria-expanded={open.has(folder.id)} onClick={() => toggle(folder.id)} title={open.has(folder.id) ? 'Cerrar' : 'Ver y editar'}>
            <FolderLogo kind={folder.kind}/>
            <span className="compact-name"><strong>{folder.name}</strong>
              <small className="muted">{scopes.find(s => s.id === folder.scopeId)?.name ?? 'Sin ámbito'} · {folder.path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}</small></span>
            {folder.outsideHome && <span className="status-badge waiting" title={SHARED_NOTICE}>Fuera de tu carpeta</span>}
            <span className="status-badge neutral">{kindLabels[folder.kind]}</span>
            <span className="compact-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        {open.has(folder.id) && <>
        <span className="muted"><code>{folder.path}</code></span>
        {folder.outsideHome && <p className="notice" role="note">{SHARED_NOTICE}</p>}
        <div className="mail-account-fields">
          <label className="field">Ámbito<ModernSelect value={folder.scopeId ? String(folder.scopeId) : ''} options={scopeOptions}
            onChange={value => void act(() => changeFiscalFolder(folder.id, { scopeId: value ? Number(value) : null }), 'Ámbito guardado.')}/></label>
          {folder.kind !== 'personal' && <label className="field">Titular en el Excel<input defaultValue={folder.holder ?? ''} maxLength={120} placeholder={folder.name}
            onBlur={event => { if (event.target.value !== (folder.holder ?? '')) void act(() => changeFiscalFolder(folder.id, { holder: event.target.value }), 'Titular guardado.'); }}/></label>}
        </div>
        <div className="field-row">
          {folder.kind !== 'personal' && <button type="button" className="button" disabled={busy} onClick={() => void calculate(folder.id)}>Proponer cómo ordenarla</button>}
          {removing === folder.id ? <span className="field-row" role="group" aria-label={`Confirmar olvidar ${folder.name}`}>
            <ActionButton icon="trash" label="Olvidar de verdad" tone="danger" onClick={() => void act(() => removeFiscalFolder(folder.id), 'Carpeta olvidada (no se ha tocado nada en ella).').then(() => setRemoving(null))}/>
            <ActionButton icon="close" label="Cancelar" onClick={() => setRemoving(null)}/></span>
            : <ActionButton icon="trash" label="Olvidar…" tone="danger" onClick={() => setRemoving(folder.id)}/>}
        </div>
        </>}
        {plan?.folder === folder.id && <div className="mail-new" aria-label="Plan de orden">
          {plan.plan.moves.length === 0 ? <p>Todo está ya en su sitio{plan.plan.undecided.length ? ', salvo lo que no se puede saber' : ''}.</p> : <>
            <p>{plan.plan.moves.length} archivos irían a «Facturas Entrantes|Salientes/año/NT», deducido de los nombres de sus carpetas:</p>
            <ul className="fiscal-moves" aria-label="Movimientos exactos">{plan.plan.moves.map(move => <li key={move.from}><code>{move.from}</code> → <code>{move.to}</code></li>)}</ul>
            {plan.plan.more > 0 && <p className="muted">Hay {plan.plan.more} más que se propondrán al volver a calcular.</p>}
          </>}
          {plan.plan.undecided.length > 0 && <details><summary className="muted">{plan.plan.undecided.length} archivos se quedan donde están: su carpeta no dice el año o el trimestre (o siguen solo en iCloud)</summary>
            <ul className="fiscal-moves">{plan.plan.undecided.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}
          {plan.plan.moves.length > 0 && (confirming ? <div className="field-row" role="group" aria-label="Confirmar movimientos">
            <button type="button" className="button primary" onClick={() => void apply()}>Mover {plan.plan.moves.length} archivos (con copia previa)</button>
            <ActionButton icon="close" label="Cancelar" onClick={() => setConfirming(false)}/>
          </div> : <button type="button" className="button" onClick={() => setConfirming(true)}>Aplicar este plan…</button>)}
        </div>}
      </li>)}
    </ul>}
    {withClaude !== null && <label className="fiscal-reading">
      <input type="checkbox" checked={withClaude} onChange={event => { const on = event.target.checked; void putFiscalReading(on).then(found => { setWithClaude(found.withClaude); setNote(on ? 'Las facturas se leerán con Claude Haiku (se vuelven a leer todas).' : 'Las facturas se leerán solo con reglas locales (se vuelven a leer todas).'); }).catch(failure => fail(failure, 'No se pudo guardar el ajuste.')); }}/>
      <span>Leer las facturas con Claude Haiku: mucho más preciso que las reglas locales. El texto de cada factura (o su imagen) va a Claude por tu sesión de Claude Code o, si no la hay, con tu clave de API de Anthropic. Sin marcar, ninguna factura sale de {hereLabel}; Fiscal sigue consultando Qonto y el cambio del BCE (solo fecha y moneda).</span>
    </label>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
