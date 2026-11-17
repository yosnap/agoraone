import { useRef, useState, type MouseEvent } from 'react';
import { archiveAllInbox, createMailRule, decideInbox, getInbox, getInboxAdvertising, type InboxCounts, type InboxItem, type InboxState } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { actionLabels, kindLabels, proposalLabels, sender, when } from './inbox-labels';
import { InvoiceFiling } from './invoice-filing';
import { ProjectNote } from './project-note';
import { ReplyComposer } from './reply-composer';
import { InboxChat } from './inbox-chat';
import { InboxDelete, type Doomed } from './inbox-delete';
import { arrange, InboxTools, readView, type View } from './inbox-tools';
import { EventForm } from '../calendar/event-form';
import { OrcaLaunch } from '../orca/orca-launch';
import { IssueFromSource } from './issue-from-source';
import { clientProjects, useOrcaProjects } from '../orca/orca-projects';
import { orcaTask } from './inbox-labels';
import '../calendar/calendar.css';

/** The first date the mail mentions, when it reads as one (the form shows it to be checked). */
const asDate = (text: string) => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());  // a day alone is the user's own day, at 9:00 (not UTC midnight)
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 9, 0) : new Date(text);
};
const firstDate = (item: InboxItem) => item.details.dates?.map(asDate).find(d => !Number.isNaN(d.getTime()) && d.getTime() > Date.now() - 86400000);
import './inbox.css';

const tabs: { state: InboxState; label: string }[] = [
  { state: 'pending', label: 'Pendientes' }, { state: 'done', label: 'Hechos' }, { state: 'dismissed', label: 'Descartados' },
];
const levelNotes = { normal: null, local_only: 'Solo en este Mac: sin resumen de modelo', private: 'Privado: sin resumen de modelo' } as const;

/** The Bandeja: summaries of incoming mail that need attention, grouped by scope. It only proposes; each
 * card is marked done or dismissed by the user, and no message triggers anything by itself. */
const ALL = '__todas__';
const scopeColors = ['#3d7ea6', '#d9822b', '#5b8c5a', '#8a6bb8', '#c0504d', '#4f9d9a'];

export function InboxView({ discreet }: { discreet: boolean }) {
  const [state, setState] = useState<InboxState>('pending');
  const [scopeTab, setScopeTab] = useState<string>(ALL);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filing, setFiling] = useState<number | null>(null);
  const [noting, setNoting] = useState<number | null>(null);
  const [scheduling, setScheduling] = useState<number | null>(null);
  const [replying, setReplying] = useState<number | null>(null);
  const [orca, setOrca] = useState<number | null>(null);
  const [issueFor, setIssueFor] = useState<number | null>(null);  // the card whose GitHub issue is being written
  const orcaProjects = useOrcaProjects();
  const [clearing, setClearing] = useState(false);
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [deleting, setDeleting] = useState<{ title: string; messages: Doomed[]; key: number } | null>(null);
  const opened = useRef(0);  // each confirmation is a new one: its ticks never carry over to another list
  const confirm = (title: string, messages: Doomed[]) => setDeleting({ title, messages, key: ++opened.current });
  const [chat, setChat] = useState(true);
  const doomed = (item: InboxItem): Doomed => ({ id: item.id, from: sender(item), subject: item.subject ?? '', date: item.sentAt, hidden: discreet });
  const pick = (id: number) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // A click anywhere on a card selects it, except on what has its own action (and the gaps between the
  // buttons), while text is being selected to copy it, or while the card holds an open form. A double
  // click that selects a word undoes the first click's change.
  const freeSpot = (event: MouseEvent, editing: boolean) => !editing && !(event.target as HTMLElement).closest('button, a, input, textarea, select, label, summary, form, '
    + '.inbox-actions, .inbox-proposal, [role="button"], [role="option"], [role="listbox"], [contenteditable="true"]');
  const pickCard = (event: MouseEvent, id: number, editing: boolean) => {
    if (event.detail > 1 || !freeSpot(event, editing) || window.getSelection()?.toString()) return;
    pick(id);
  };
  const wordPicked = (event: MouseEvent, id: number, editing: boolean) => {
    if (freeSpot(event, editing) && window.getSelection()?.toString()) pick(id);
  };
  const deleted = (done: string) => { setDeleting(null); setSelected(new Set()); setNote(done); void load(); };
  const askAdvertising = async () => {
    setNote(''); setError('');
    try {
      const found = (await getInboxAdvertising()).messages;
      if (!found.length) { setNote('No queda publicidad en la bandeja de entrada de tus cuentas.'); return; }
      confirm(`Eliminar publicidad: ${found.length} ${found.length === 1 ? 'correo' : 'correos'}`,
        found.map(m => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, hidden: discreet })));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo buscar la publicidad.'); }
  };
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
    try { const data = await getInbox(which); if (mine !== request.current) return; setItems(data.items);
      setSelected(current => new Set([...current].filter(id => data.items.some(item => item.id === id && !item.moved)))); setCounts(data.counts); setProblem(data.problem); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer la Bandeja.'); }
  };
  if (!asked.current) { asked.current = true; void load(); }
  const show = (which: InboxState) => { setState(which); setItems(null); setSelected(new Set()); void load(which); };
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
  const shown = arrange(items ?? [], view);
  for (const item of shown) groups.set(item.scope?.name ?? 'Sin ámbito', [...(groups.get(item.scope?.name ?? 'Sin ámbito') ?? []), item]);
  // One tab per scope (Profesional, Personal y profesional, Personal…), each with its own colour (1.6.2).
  const scopes = [...groups.keys()];
  const shownScope = scopeTab !== ALL && groups.has(scopeTab) ? scopeTab : ALL;
  const colorOf = (scope: string) => scopeColors[scopes.indexOf(scope) % scopeColors.length];
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
        <button type="button" className="button act-delete" onClick={() => void askAdvertising()}>Eliminar publicidad…</button>
        {selected.size > 0 && <>
          <button type="button" className="button act-delete" onClick={() => confirm(`Eliminar ${selected.size} ${selected.size === 1 ? 'correo seleccionado' : 'correos seleccionados'}`,
            (items ?? []).filter(item => selected.has(item.id)).map(doomed))}>Eliminar {selected.size} seleccionados…</button>
          <button type="button" className="button" onClick={() => setSelected(new Set())}>Quitar selección</button></>}
        <button type="button" className="button" aria-pressed={chat} onClick={() => setChat(!chat)}>{chat ? 'Ocultar chat' : 'Chat de la Bandeja'}</button>
        {state === 'pending' && (counts?.pending ?? 0) > 0 && !clearing && <button type="button" className="button" onClick={() => setClearing(true)}>Archivar todo lo que hay ahora…</button>}
      </div>
    </div>
    {clearing && <div className="card-head inbox-bar" role="group" aria-label="Confirmar archivar todo">
      <p>Las {counts?.pending} tarjetas pendientes pasan a «Hechos» y, desde ahora, la Bandeja solo resume el correo que llegue (tampoco el antiguo de las cuentas que añadas). No se mueve ni se borra ningún correo.</p>
      <div className="inbox-actions"><button type="button" className="button primary" onClick={() => void clearAll()}>Archivar {counts?.pending} tarjetas</button>
        <button type="button" className="button" onClick={() => setClearing(false)}>Cancelar</button></div>
    </div>}
    {deleting && <InboxDelete key={deleting.key} title={deleting.title} messages={deleting.messages} onCancel={() => setDeleting(null)} onDone={deleted}/>}
    <div className={`inbox-layout${chat ? '' : ' alone'}`}><div className="inbox-main">
    <InboxTools view={view} onChange={setView} kinds={[...new Set((items ?? []).map(item => item.kind))]}/>
    {scopes.length > 1 && <div className="segmented inbox-scopes" role="group" aria-label="Ámbito">
      <button type="button" aria-pressed={shownScope === ALL} onClick={() => setScopeTab(ALL)}>Todas · {shown.length}</button>
      {scopes.map(scope => <button key={scope} type="button" aria-pressed={shownScope === scope} onClick={() => setScopeTab(scope)}>
        <span className="scope-dot" style={{ background: colorOf(scope) }} aria-hidden="true"/>{scope} · {groups.get(scope)!.length}</button>)}
    </div>}
    {counts?.since && <p className="muted">Bandeja desde el {new Date(counts.since).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })}: lo anterior no se resume.</p>}
    {counts && counts.unread > 0 && <p className="muted" role="status">{counts.unread} correos recientes esperan su resumen; se leen en segundo plano.</p>}
    {problem && <LoadError message={problem}/>}
    {error && <LoadError message={error} onRetry={() => void load()}/>}
    {note && <p className="ok-note" role="status">{note}</p>}
    {items === null ? <Loading label="Leyendo la Bandeja" lines={4}/>
      : items.length > 0 && shown.length === 0 ? <p className="muted">Ningún correo coincide con la búsqueda.</p>
      : items.length === 0 ? <p className="muted">{state === 'pending' ? 'No hay nada pendiente. Si acabas de conectar una cuenta, los resúmenes llegan en unos minutos.' : 'Nada por aquí.'}</p>
      : [...groups].filter(([scope]) => shownScope === ALL || scope === shownScope).map(([scope, cards]) => <div key={scope} className="inbox-group">
        <h2><span className="scope-dot" style={{ background: colorOf(scope) }} aria-hidden="true"/>{scope} <span className="muted">· {cards.length}</span></h2>
        <ul className={`inbox-cards per-${view.perRow}${cards.some(c => [filing, noting, scheduling, replying, orca, issueFor].includes(c.id)) ? ' editing' : ''}`}>{cards.map(item => { const editing = [filing, noting, scheduling, replying, orca, issueFor].includes(item.id); return <li key={item.id}
          className={`card inbox-card${selected.has(item.id) ? ' chosen' : ''}${!item.moved && !editing ? ' pickable' : ''}${(noting === item.id || issueFor === item.id) && !discreet ? ' wide' : ''}`}
          onClick={item.moved ? undefined : event => pickCard(event, item.id, editing)}
          onDoubleClick={item.moved ? undefined : event => wordPicked(event, item.id, editing)}>
          <div className="card-head">
            <div className="inbox-chips">{item.moved ? <span className="chip">{item.moved === 'trash' ? 'En la Papelera' : 'Archivado'}</span> : <label className="check inbox-pick" title="Seleccionar"><input type="checkbox" checked={selected.has(item.id)} onChange={() => pick(item.id)}
              aria-label={`Seleccionar ${discreet ? 'este correo' : item.subject || 'correo sin asunto'}`}/></label>}<span className={`chip kind-${item.kind}`}>{kindLabels[item.kind]}</span>
              {item.source === 'rule' && item.ruleName && <span className="chip">Regla: {item.ruleName}</span>}
              {item.client && <span className="chip good" title={!discreet && item.client.projects.length ? `Proyectos activos: ${item.client.projects.join(', ')}` : undefined}>
                {discreet ? 'Cliente de Central' : `Cliente: ${item.client.name}`}{!discreet && item.client.projects.length ? ` · ${item.client.projects.length} proyecto${item.client.projects.length > 1 ? 's' : ''}` : ''}</span>}
              {levelNotes[item.confidentiality] && <span className="chip warn">{levelNotes[item.confidentiality]}</span>}</div>
            <span className="muted">{when(item.sentAt)}</span>
          </div>
          <p className="inbox-from"><strong>{sender(item)}</strong>{item.from.address && item.from.name ? ` · ${item.from.address}` : ''} <span className="muted">→ {item.account.address}</span></p>
          {discreet ? <p className="muted">Asunto y resumen ocultos en modo discreto.</p> : <>
            <p className="inbox-subject">{item.subject || '(sin asunto)'}{item.attachments > 0 ? ` · ${item.attachments} adjunto${item.attachments > 1 ? 's' : ''}` : ''}</p>
            {item.summary && <p className="inbox-summary">{item.summary}</p>}
            {(item.details.asks?.length || item.details.amounts?.length || item.details.dates?.length) ? <ul className="inbox-details">
              {item.details.asks?.map((ask, index) => <li key={index}>Piden: {ask}</li>)}
              {item.details.amounts?.length ? <li>Importes: {item.details.amounts.join(', ')}</li> : null}
              {item.details.dates?.length ? <li>Fechas: {item.details.dates.join(', ')}</li> : null}
            </ul> : null}
          </>}
          {item.proposal === 'archive_invoice' && item.state === 'pending' ? (filing === item.id
            ? <InvoiceFiling messageId={item.id} onFiled={path => { setFiling(null); setNote(`Factura archivada en ${path}.`); void load(); }}/>
            : <p className="inbox-proposal"><button type="button" className="button" onClick={() => setFiling(item.id)}>{proposalLabels.archive_invoice.label}…</button></p>)
            : (item.proposal === 'add_to_project' || item.client) && item.state === 'pending' ? (noting === item.id && !discreet
              ? <ProjectNote item={item} onCancel={() => setNoting(null)} onDone={done => { setNoting(null); setNote(done); void load(); }}/>
              : <p className="inbox-proposal"><button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para ver y escribir la nota' : undefined}
                onClick={() => setNoting(item.id)}>{proposalLabels.add_to_project.label}…</button></p>)
            : item.proposal === 'create_event' && item.state === 'pending' && (scheduling === item.id && !discreet
              ? <EventForm inboxId={item.id} initial={{ title: (item.subject ?? '').slice(0, 200), start: firstDate(item), notes: (item.summary ?? '').slice(0, 4000) }}
                onCancel={() => setScheduling(null)} onDone={done => { setScheduling(null); setNote(`${done} La tarjeta pasa a «Hechos».`); void load(); }}/>
              : <p className="inbox-proposal"><button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para crear el evento' : undefined}
                onClick={() => setScheduling(item.id)}>{proposalLabels.create_event.label}…</button></p>)}
          {replying === item.id && !discreet && <ReplyComposer item={item} onCancel={() => setReplying(null)}
            onDone={done => { setReplying(null); setNote(done); void load(); }}/>}
          {orca === item.id && !discreet && <OrcaLaunch choices={clientProjects(orcaProjects, item.client?.name)} client={item.client?.name} project={item.client?.projects[0]}
            source={{ kind: 'mail', id: item.id }} task={orcaTask} onClose={() => setOrca(null)}/>}
          {issueFor === item.id && !discreet && <IssueFromSource source={{ kind: 'mail', id: item.id }} client={item.client?.name} project={item.client?.projects[0]}
            title={item.subject?.replace(/^\s*((re|rv|fw|fwd)\s*:\s*)+/i, '').trim() || 'Petición del cliente'}
            body={[item.summary ?? '', ...(item.details.asks?.length ? ['', 'Lo que pide:', ...item.details.asks.map(ask => `- ${ask}`)] : []),
              '', `(Correo de ${item.from.name || 'el cliente'} del ${new Date(item.sentAt).toLocaleDateString('es-ES')}.)`].join('\n').trim()}
            onClose={done => { setIssueFor(null); if (done) setNote(done); }}/>}
          <div className="inbox-actions">
            {item.state === 'pending' ? <>
              <button type="button" className="button primary" onClick={() => void decide(item, 'done')}>Hecho</button>
              <button type="button" className="button" onClick={() => void decide(item, 'dismissed')}>Descartar</button>
              {replying !== item.id && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para responder' : undefined}
                onClick={() => setReplying(item.id)}>Responder…</button>}
              {orca !== item.id && item.confidentiality === 'normal' && !item.moved && clientProjects(orcaProjects, item.client?.name).length > 0
                && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para ver qué se enviará' : 'Crear un espacio de trabajo en Orca con un agente para este correo'}
                  onClick={() => setOrca(item.id)}>Llevar a Orca…</button>}
              {issueFor !== item.id && item.confidentiality === 'normal' && !item.moved && item.client
                && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para escribir la issue' : 'Crear una issue en el repositorio del proyecto'}
                  onClick={() => setIssueFor(item.id)}>Crear issue…</button>}
            </> : <button type="button" className="button" onClick={() => void decide(item, 'pending')}>Volver a Pendientes</button>}
            {!item.moved && <button type="button" className="button act-delete" onClick={() => confirm('Eliminar este correo', [doomed(item)])}>Eliminar…</button>}
            {item.suggestion && <button type="button" className="button" onClick={() => void makeRule(item)}
              title={`${actionLabels[item.suggestion.action]} para todo lo que venga de ${item.suggestion.sender}`}>Crear regla «{item.suggestion.name}»</button>}
          </div>
        </li>; })}</ul>
      </div>)}
    </div>
    {chat && <InboxChat discreet={discreet} onChanged={() => void load()}/>}
    </div>
  </section>;
}
