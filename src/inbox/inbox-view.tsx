import { useRef, useState, type MouseEvent } from 'react';
import { archiveAllInbox, createMailRule, decideChat, decideInbox, getChatSettings, getChatSummaries, getInbox, getInboxAdvertising,
  type ChatSummary, type InboxCounts, type InboxItem, type InboxState } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { sender, type CardAction } from './inbox-labels';
import { InboxChat } from './inbox-chat';
import { InboxDelete, type Doomed } from './inbox-delete';
import { InboxTools, readView } from './inbox-tools';
import { arrange, cardKey, type Card, type View } from './inbox-cards';
import { MailCard } from './mail-card';
import { ChatCard } from './chat-card';
import { useOrcaProjects } from '../orca/orca-projects';
import { moduleOn, modulesRead, useModules } from '../shell/modules';
import '../calendar/calendar.css';
import './inbox.css';

const tabs: { state: InboxState; label: string }[] = [
  { state: 'pending', label: 'Pendientes' }, { state: 'done', label: 'Hechos' }, { state: 'dismissed', label: 'Descartados' },
];
type ChatCounts = Record<InboxState | 'quiet', number>;

/** The Bandeja: summaries of incoming mail and WhatsApp conversations that need attention, in one list grouped by
 * scope. It only proposes; each card is marked done or dismissed by the user, and no message triggers anything by
 * itself. WhatsApp's cards are asked for only with its module on and a key saved (never from Zernio here). */
const ALL = '__todas__';
const scopeColors = ['#3d7ea6', '#d9822b', '#5b8c5a', '#8a6bb8', '#c0504d', '#4f9d9a'];

export function InboxView({ discreet }: { discreet: boolean }) {
  const [state, setState] = useState<InboxState>('pending');
  const [scopeTab, setScopeTab] = useState<string>(ALL);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatCounts, setChatCounts] = useState<ChatCounts | null>(null);  // null: WhatsApp's cards are not shown
  const [problem, setProblem] = useState<string | null>(null);
  const [chatProblem, setChatProblem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<Partial<Record<CardAction, string>>>({});  // each action open on one card at most
  const orcaProjects = useOrcaProjects();
  const modules = useModules();
  const whatsapp = moduleOn(modules, 'whatsapp');
  const [clearing, setClearing] = useState(false);
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());  // mail ids: only mail can be deleted
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
  const pendingTotal = (counts?.pending ?? 0) + (chatCounts?.pending ?? 0);
  const clearAll = async () => {
    setNote(''); setClearing(false);
    try {
      const done = await archiveAllInbox();
      setNote(`${done.archived + done.chats} tarjetas archivadas en «Hechos»${done.chats ? ` (${done.chats} de WhatsApp)` : ''}. Desde ahora solo se resume el correo que llegue.`);
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); }
  };
  const asked = useRef(false);
  const request = useRef(0);  // only the latest read is shown (a slow answer for another tab is dropped)
  const chatKey = useRef<boolean | null>(null);  // whether a Zernio key is saved, read once from the core (not from Zernio)
  const loadChats = async (which: InboxState, mine: number) => {
    if (!whatsapp) { setChats([]); setChatCounts(null); setChatProblem(null); return; }
    try {
      if (chatKey.current === null) chatKey.current = (await getChatSettings()).hasKey;
      if (!chatKey.current) { if (mine === request.current) { setChats([]); setChatCounts(null); setChatProblem(null); } return; }
      const data = await getChatSummaries(which);
      if (mine !== request.current) return;
      setChats(data.items); setChatCounts(data.counts); setChatProblem(data.problem);
    } catch (failure) {  // the mail is still shown, with WhatsApp's own warning
      if (mine === request.current) { setChats([]); setChatProblem(failure instanceof Error ? failure.message : 'No se pudo leer WhatsApp.'); }
    }
  };
  const load = async (which: InboxState = state) => {
    setError('');
    const mine = ++request.current;
    const reading = loadChats(which, mine);
    try { const data = await getInbox(which); if (mine !== request.current) return; setItems(data.items);
      setSelected(current => new Set([...current].filter(id => data.items.some(item => item.id === id && !item.moved)))); setCounts(data.counts); setProblem(data.problem); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer la Bandeja.'); if (mine === request.current) setItems(current => current ?? []); }
    await reading;
  };
  if (!asked.current && modulesRead()) { asked.current = true; void load(); }  // once the modules say whether WhatsApp is on
  const show = (which: InboxState) => { setState(which); setItems(null); setChats([]); setSelected(new Set()); void load(which); };
  const said = (next: InboxState) => setNote(next === 'done' ? 'Marcado como hecho.' : next === 'dismissed' ? 'Descartado.' : 'Vuelve a Pendientes.');
  const decide = async (item: InboxItem, next: InboxState) => {
    setNote('');
    try { await decideInbox(item.id, next); said(next); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const decideConversation = async (item: ChatSummary, next: InboxState) => {
    setNote('');
    try { await decideChat(item.id, next); said(next); await load(); }
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
  const noted = (text: string) => { setNote(text); void load(); };
  const withChat = chatCounts !== null;
  const cards: Card[] = [...(items ?? []).map(item => ({ source: 'mail', item }) as Card), ...(withChat ? chats : []).map(item => ({ source: 'chat', item }) as Card)];
  const shown = arrange(cards, withChat ? view : { ...view, source: 'all' });
  const groups = new Map<string, Card[]>();
  for (const card of shown) groups.set(card.item.scope?.name ?? 'Sin ámbito', [...(groups.get(card.item.scope?.name ?? 'Sin ámbito') ?? []), card]);
  // One tab per scope (Profesional, Personal y profesional, Personal…), each with its own colour (1.6.2).
  const scopes = [...groups.keys()];
  const shownScope = scopeTab !== ALL && groups.has(scopeTab) ? scopeTab : ALL;
  const colorOf = (scope: string) => scopeColors[scopes.indexOf(scope) % scopeColors.length];
  const isOpen = (key: string) => (action: CardAction) => open[action] === key;
  const showAction = (key: string) => (action: CardAction, on: boolean) => setOpen(current => ({ ...current, [action]: on ? key : current[action] === key ? undefined : current[action] }));
  const editing = (key: string) => Object.values(open).includes(key);
  const count = (which: InboxState) => counts || chatCounts ? ` · ${(counts?.[which] ?? 0) + (chatCounts?.[which] ?? 0)}` : '';
  // Entering discreet mode closes a conversation's open messages: leaving it does not show them again unasked.
  const lastDiscreet = useRef(discreet);
  if (lastDiscreet.current !== discreet) { lastDiscreet.current = discreet; if (discreet && open.messages) setOpen(current => ({ ...current, messages: undefined })); }
  return <section className="page inbox" aria-labelledby="inbox-title">
    <div className="eyebrow">BANDEJA{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="inbox-title">Bandeja</h1>
    <p className="page-lead">Resúmenes de los correos{withChat ? ' y las conversaciones de WhatsApp' : ''} que piden atención, según tus reglas o, sin regla, según la clasificación automática.
      Aquí solo se propone: nada se archiva, envía ni añade sin que lo confirmes. Las reglas están en Ajustes › Reglas del correo{withChat ? ' y Ajustes › WhatsApp' : ''}.</p>
    <div className="card-head inbox-bar">
      <div className="segmented" role="group" aria-label="Estado">{tabs.map(tab =>
        <button key={tab.state} aria-pressed={state === tab.state} onClick={() => show(tab.state)}>{tab.label}{count(tab.state)}</button>)}</div>
      <div className="inbox-actions">
        <button type="button" className="button" onClick={() => void load()}>Actualizar</button>
        <button type="button" className="button act-delete" onClick={() => void askAdvertising()}>Eliminar publicidad…</button>
        {selected.size > 0 && <>
          <button type="button" className="button act-delete" onClick={() => confirm(`Eliminar ${selected.size} ${selected.size === 1 ? 'correo seleccionado' : 'correos seleccionados'}`,
            (items ?? []).filter(item => selected.has(item.id)).map(doomed))}>Eliminar {selected.size} seleccionados…</button>
          <button type="button" className="button" onClick={() => setSelected(new Set())}>Quitar selección</button></>}
        <button type="button" className="button" aria-pressed={chat} onClick={() => setChat(!chat)}>{chat ? 'Ocultar chat' : 'Chat de la Bandeja'}</button>
        {state === 'pending' && pendingTotal > 0 && !clearing && <button type="button" className="button" onClick={() => setClearing(true)}>Archivar todo lo que hay ahora…</button>}
      </div>
    </div>
    {clearing && <div className="card-head inbox-bar" role="group" aria-label="Confirmar archivar todo">
      <p>Las {pendingTotal} tarjetas pendientes{chatCounts?.pending ? `, ${chatCounts.pending} de ellas de WhatsApp,` : ''} pasan a «Hechos» y, desde ahora, la Bandeja solo resume el correo que llegue (tampoco el antiguo de las cuentas que añadas).
        {chatCounts?.pending ? ' Una conversación vuelve a Pendientes cuando recibes algo nuevo.' : ''} No se mueve ni se borra ningún correo ni mensaje.</p>
      <div className="inbox-actions"><button type="button" className="button primary" onClick={() => void clearAll()}>Archivar {pendingTotal} tarjetas</button>
        <button type="button" className="button" onClick={() => setClearing(false)}>Cancelar</button></div>
    </div>}
    {deleting && <InboxDelete key={deleting.key} title={deleting.title} messages={deleting.messages} onCancel={() => setDeleting(null)} onDone={deleted}/>}
    <div className={`inbox-layout${chat ? '' : ' alone'}`}><div className="inbox-main">
    <InboxTools view={view} onChange={setView} chat={withChat} kinds={[...new Set(cards.map(card => card.item.kind))]}/>
    {scopes.length > 1 && <div className="segmented inbox-scopes" role="group" aria-label="Ámbito">
      <button type="button" aria-pressed={shownScope === ALL} onClick={() => setScopeTab(ALL)}>Todas · {shown.length}</button>
      {scopes.map(scope => <button key={scope} type="button" aria-pressed={shownScope === scope} onClick={() => setScopeTab(scope)}>
        <span className="scope-dot" style={{ background: colorOf(scope) }} aria-hidden="true"/>{scope} · {groups.get(scope)!.length}</button>)}
    </div>}
    {counts?.since && <p className="muted">Bandeja desde el {new Date(counts.since).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })}: lo anterior no se resume.</p>}
    {counts && counts.unread > 0 && <p className="muted" role="status">{counts.unread} correos recientes esperan su resumen; se leen en segundo plano.</p>}
    {problem && <LoadError message={problem}/>}
    {chatProblem && <LoadError message={`WhatsApp: ${chatProblem}`}/>}
    {error && <LoadError message={error} onRetry={() => void load()}/>}
    {note && <p className="ok-note" role="status">{note}</p>}
    {items === null ? <Loading label="Leyendo la Bandeja" lines={4}/>
      : cards.length > 0 && shown.length === 0 ? <p className="muted">Nada coincide con la búsqueda.</p>
      : cards.length === 0 ? !error && <p className="muted">{state === 'pending' ? 'No hay nada pendiente. Si acabas de conectar una cuenta, los resúmenes llegan en unos minutos.' : 'Nada por aquí.'}</p>
      : [...groups].filter(([scope]) => shownScope === ALL || scope === shownScope).map(([scope, group]) => <div key={scope} className="inbox-group">
        <h2><span className="scope-dot" style={{ background: colorOf(scope) }} aria-hidden="true"/>{scope} <span className="muted">· {group.length}</span></h2>
        <ul className={`inbox-cards per-${view.perRow}${group.some(card => editing(cardKey(card))) ? ' editing' : ''}`}>{group.map(card => {
          const key = cardKey(card);
          if (card.source === 'chat') return <ChatCard key={key} item={card.item} discreet={discreet} isOpen={isOpen(key)} show={showAction(key)}
            orcaProjects={orcaProjects} onDecide={next => void decideConversation(card.item, next)} onNote={noted}/>;
          const item = card.item;
          return <MailCard key={key} item={item} discreet={discreet} selected={selected.has(item.id)} editing={editing(key)} isOpen={isOpen(key)} show={showAction(key)}
            orcaProjects={orcaProjects} onPick={event => pickCard(event, item.id, editing(key))} onPickWord={event => wordPicked(event, item.id, editing(key))}
            onToggle={() => pick(item.id)} onDecide={next => void decide(item, next)} onRule={() => void makeRule(item)}
            onDelete={() => confirm('Eliminar este correo', [doomed(item)])} onNote={noted}/>;
        })}</ul>
      </div>)}
    </div>
    {chat && <InboxChat discreet={discreet} onChanged={() => void load()}/>}
    </div>
  </section>;
}
