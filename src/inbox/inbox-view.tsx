import { useRef, useState } from 'react';
import { archiveAllInbox, createMailRule, decideInbox, getInbox, type InboxCounts, type InboxItem, type InboxState } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { actionLabels, kindLabels, proposalLabels, sender, when } from './inbox-labels';
import { InvoiceFiling } from './invoice-filing';
import { ReceiptsPanel } from './receipts-panel';
import './inbox.css';

const tabs: { state: InboxState; label: string }[] = [
  { state: 'pending', label: 'Pendientes' }, { state: 'done', label: 'Hechos' }, { state: 'dismissed', label: 'Descartados' },
];
const tone: Partial<Record<InboxItem['kind'], string>> = { invoice: 'warn', payment: 'warn', client: 'good', incident: 'bad', appointment: 'good', important: 'bad' };
const levelNotes = { normal: null, local_only: 'Solo en este Mac: sin resumen de modelo', private: 'Privado: sin resumen de modelo' } as const;

/** The Bandeja: summaries of incoming mail that need attention, grouped by scope. It only proposes; each
 * card is marked done or dismissed by the user, and no message triggers anything by itself. */
export function InboxView({ discreet }: { discreet: boolean }) {
  const [state, setState] = useState<InboxState>('pending');
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filing, setFiling] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const clearAll = async () => {
    setNote(''); setClearing(false);
    try { const done = await archiveAllInbox(); setNote(`${done.archived} tarjetas archivadas en «Hechos». Desde ahora solo se resume lo que llegue.`); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); }
  };
  const asked = useRef(false);
  const request = useRef(0);  // only the latest read is shown (a slow answer for another tab is dropped)
  const load = async (which: InboxState = state) => {
    setError('');
    const mine = ++request.current;
    try { const data = await getInbox(which); if (mine !== request.current) return; setItems(data.items); setCounts(data.counts); setProblem(data.problem); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer la Bandeja.'); }
  };
  if (!asked.current) { asked.current = true; void load(); }
  const show = (which: InboxState) => { setState(which); setItems(null); void load(which); };
  const decide = async (item: InboxItem, next: InboxState) => {
    setNote('');
    try { await decideInbox(item.id, next); setNote(next === 'done' ? 'Marcado como hecho.' : next === 'dismissed' ? 'Descartado.' : 'Vuelve a Pendientes.'); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const makeRule = async (item: InboxItem) => {
    if (!item.suggestion) return;
    setNote('');
    try {
      await createMailRule({ ...item.suggestion, accountId: null, subject: null, words: null, scopeId: item.scope?.id ?? null, confidentiality: null, enabled: true });
      setNote(`Regla «${item.suggestion.name}» creada. Si una regla anterior también coincide, manda la anterior; puedes cambiarlas en Ajustes › Reglas del correo.`); await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo crear la regla.'); }
  };
  const groups = new Map<string, InboxItem[]>();
  for (const item of items ?? []) groups.set(item.scope?.name ?? 'Sin ámbito', [...(groups.get(item.scope?.name ?? 'Sin ámbito') ?? []), item]);
  return <section className="page inbox" aria-labelledby="inbox-title">
    <div className="eyebrow">BANDEJA{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="inbox-title">Bandeja</h1>
    <p className="page-lead">Resúmenes de los correos que piden atención, según tus reglas o, sin regla, según la clasificación automática.
      Aquí solo se propone: nada se archiva, envía ni añade sin que lo confirmes. Las reglas están en Ajustes › Reglas del correo.</p>
    <div className="card-head inbox-bar">
      <div className="segmented" role="group" aria-label="Estado">{tabs.map(tab =>
        <button key={tab.state} aria-pressed={state === tab.state} onClick={() => show(tab.state)}>{tab.label}{counts ? ` · ${counts[tab.state]}` : ''}</button>)}</div>
      <div className="inbox-actions">
        <button type="button" className="button" onClick={() => void load()}>Actualizar</button>
        {state === 'pending' && (counts?.pending ?? 0) > 0 && !clearing && <button type="button" className="button" onClick={() => setClearing(true)}>Archivar todo lo que hay ahora…</button>}
      </div>
    </div>
    {clearing && <div className="card-head inbox-bar" role="group" aria-label="Confirmar archivar todo">
      <p>Las {counts?.pending} tarjetas pendientes pasan a «Hechos» y, desde ahora, la Bandeja solo resume el correo que llegue (tampoco el antiguo de las cuentas que añadas). No se mueve ni se borra ningún correo.</p>
      <div className="inbox-actions"><button type="button" className="button primary" onClick={() => void clearAll()}>Archivar {counts?.pending} tarjetas</button>
        <button type="button" className="button" onClick={() => setClearing(false)}>Cancelar</button></div>
    </div>}
    {counts?.since && <p className="muted">Bandeja desde el {new Date(counts.since).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })}: lo anterior no se resume.</p>}
    {counts && counts.unread > 0 && <p className="muted" role="status">{counts.unread} correos recientes esperan su resumen; se leen en segundo plano.</p>}
    {problem && <LoadError message={problem}/>}
    {error && <LoadError message={error} onRetry={() => void load()}/>}
    {note && <p className="ok-note" role="status">{note}</p>}
    {state === 'pending' && <ReceiptsPanel onNote={setNote}/>}
    {items === null ? <Loading label="Leyendo la Bandeja" lines={4}/>
      : items.length === 0 ? <p className="muted">{state === 'pending' ? 'No hay nada pendiente. Si acabas de conectar una cuenta, los resúmenes llegan en unos minutos.' : 'Nada por aquí.'}</p>
      : [...groups].map(([scope, cards]) => <div key={scope} className="inbox-group">
        <h2>{scope} <span className="muted">· {cards.length}</span></h2>
        <ul className="inbox-cards">{cards.map(item => <li key={item.id} className="card inbox-card">
          <div className="card-head">
            <div className="inbox-chips"><span className={`chip ${tone[item.kind] ?? ''}`}>{kindLabels[item.kind]}</span>
              {item.source === 'rule' && item.ruleName && <span className="chip">Regla: {item.ruleName}</span>}
              {item.client && <span className="chip good" title={!discreet && item.client.projects.length ? `Proyectos activos: ${item.client.projects.join(', ')}` : undefined}>
                {discreet ? 'Cliente de Central' : `Cliente: ${item.client.name}`}{!discreet && item.client.projects.length ? ` · ${item.client.projects.length} proyecto${item.client.projects.length > 1 ? 's' : ''}` : ''}</span>}
              {levelNotes[item.confidentiality] && <span className="chip warn">{levelNotes[item.confidentiality]}</span>}</div>
            <span className="muted">{when(item.sentAt)}</span>
          </div>
          <p className="inbox-from"><strong>{sender(item)}</strong>{item.from.address && item.from.name ? ` · ${item.from.address}` : ''} <span className="muted">→ {item.account.address}</span></p>
          {discreet ? <p className="muted">Asunto y resumen ocultos en modo discreto.</p> : <>
            <p className="inbox-subject">{item.subject || '(sin asunto)'}{item.attachments > 0 ? ` · ${item.attachments} adjunto${item.attachments > 1 ? 's' : ''}` : ''}</p>
            {item.summary && <p>{item.summary}</p>}
            {(item.details.asks?.length || item.details.amounts?.length || item.details.dates?.length) ? <ul className="inbox-details">
              {item.details.asks?.map((ask, index) => <li key={index}>Piden: {ask}</li>)}
              {item.details.amounts?.length ? <li>Importes: {item.details.amounts.join(', ')}</li> : null}
              {item.details.dates?.length ? <li>Fechas: {item.details.dates.join(', ')}</li> : null}
            </ul> : null}
          </>}
          {item.proposal === 'archive_invoice' && item.state === 'pending' ? (filing === item.id
            ? <InvoiceFiling messageId={item.id} onFiled={path => { setFiling(null); setNote(`Factura archivada en ${path}.`); void load(); }}/>
            : <p className="inbox-proposal"><button type="button" className="button" onClick={() => setFiling(item.id)}>{proposalLabels.archive_invoice.label}…</button></p>)
            : item.proposal && item.proposal !== 'archive_invoice' && <p className="inbox-proposal"><button type="button" className="button" disabled title="Pendiente">{proposalLabels[item.proposal].label}</button>
            <span className="muted">Pendiente: {proposalLabels[item.proposal].arrives}.</span></p>}
          <div className="inbox-actions">
            {item.state === 'pending' ? <>
              <button type="button" className="button primary" onClick={() => void decide(item, 'done')}>Hecho</button>
              <button type="button" className="button" onClick={() => void decide(item, 'dismissed')}>Descartar</button>
            </> : <button type="button" className="button" onClick={() => void decide(item, 'pending')}>Volver a Pendientes</button>}
            {item.suggestion && <button type="button" className="button" onClick={() => void makeRule(item)}
              title={`${actionLabels[item.suggestion.action]} para todo lo que venga de ${item.suggestion.sender}`}>Crear regla «{item.suggestion.name}»</button>}
          </div>
        </li>)}</ul>
      </div>)}
  </section>;
}
