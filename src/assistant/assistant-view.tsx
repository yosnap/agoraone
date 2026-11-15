import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RuleProposals, useProposals } from './rule-proposals';
import {
  askAssistant, createAssistantConversation, getAssistantConversation, getAssistantSettings, getEngines, getPersonas, listAssistantConversations,
  type AssistantMessage, type ConversationSummary, type Persona, type Source, type Stage,
} from '../api/core';
import { Markdown } from '../ui/markdown';
import { Loading, LoadError } from '../ui/load-state';
import type { NoteRef } from '../brain/note-reader';
import { engineName, modelName, stageLabels } from './assistant-labels';
import { play } from '../sound/sound';
import { Announcements, useAnnouncements } from './assistant-announce';
import './assistant.css';

type Live = { question: string; stage: Stage | null; sources: Source[]; text: string; engine?: string; model?: string; steps: string[] };
/** What Watson is doing right now, for the graph beside it: real events only. */
export type Thinking = { stage: Stage | 'busca' | 'lee' | null; label: string; reading: string[] } | null;
const noLinks = () => null;
const sourceId = (source: Source) => `${source.source}/${source.ref}`;
const lastSources = (messages: AssistantMessage[]) => [...messages].reverse().find(message => message.role === 'assistant')?.sources.map(sourceId) ?? [];

/** Watson (or the chosen character): conversations kept in the brain, answers streamed with their real stages,
 * the engine and model that answered, and the notes cited, which open as books or light up on the graph. */
export function AssistantView({ question = null, onQuestionTaken, onRead, onShowOnGraph, embedded = false, onSources, onThinking, discreet = false }: {
  question?: string | null; onQuestionTaken?: () => void; onRead: (note: NoteRef) => void; onShowOnGraph?: (ids: string[]) => void;
  /** Beside the graph: conversations fold into a menu and cited notes light up on their own. */
  embedded?: boolean; onSources?: (ids: string[]) => void; onThinking?: (thinking: Thinking) => void; discreet?: boolean;
}) {
  const [listOpen, setListOpen] = useState(!embedded);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [listError, setListError] = useState('');
  const [current, setCurrent] = useState<number | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [persona, setPersona] = useState<Persona | null>(null);
  const [engine, setEngine] = useState<{ active: string | null; model: string } | null>(null);
  const announced = useAnnouncements();
  const proposals = useProposals();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  // The conversation on screen, read by answers that finish after the user moved to another one.
  const shownId = useRef<number | null>(null);
  shownId.current = current;
  const refreshList = useCallback(() => listAssistantConversations().then(data => { setConversations(data.conversations); setListError(''); })
    .catch(failure => setListError(failure instanceof Error ? failure.message : 'No se pudieron leer las conversaciones.')), []);
  useEffect(() => {
    void refreshList();
    Promise.all([getPersonas(), getAssistantSettings()]).then(([list, settings]) => setPersona(list.personas.find(item => item.id === settings.persona) ?? null)).catch(() => undefined);
    getEngines().then(setEngine).catch(() => setEngine({ active: null, model: '' }));
    return () => abort.current?.abort();
  }, [refreshList]);
  const open = useCallback(async (id: number) => {
    abort.current?.abort();
    setCurrent(id); setLive(null); setError(''); setLoading(true); proposals.clear();
    if (embedded) setListOpen(false);
    try { const found = (await getAssistantConversation(id)).messages; setMessages(found); onSources?.(lastSources(found)); }
    catch (failure) { setMessages([]); setError(failure instanceof Error ? failure.message : 'No se pudo abrir la conversación.'); }
    finally { setLoading(false); }
  }, []);
  const send = useCallback(async (text: string, into: number | null) => {
    let id = into;
    setError('');
    try {
      if (id === null) { id = (await createAssistantConversation()).id; shownId.current = id; setCurrent(id); setMessages([]); }
      const controller = new AbortController();
      abort.current = controller;
      setLive({ question: text, stage: null, sources: [], text: '', steps: [] });
      play('send');
      const reading: string[] = [];
      await askAssistant(id, text, event => {
        if (event.kind === 'done') play('receive');
        if (event.kind === 'stage') onThinking?.({ stage: event.stage, label: stageLabels[event.stage], reading });
        else if (event.kind === 'tool' && event.tool === 'search') onThinking?.({ stage: 'busca', label: `Buscando «${event.query}»`, reading });
        else if (event.kind === 'tool' && event.tool === 'clients') onThinking?.({ stage: 'busca', label: 'Consultando los clientes', reading });
        else if (event.kind === 'tool' && event.tool === 'inbox') onThinking?.({ stage: 'busca', label: 'Consultando la Bandeja', reading });
        else if (event.kind === 'tool' && event.tool === 'rule_proposal') proposals.add(event.id, event.rule);
        else if (event.kind === 'tool' && event.tool === 'read') { reading.push(event.id); onThinking?.({ stage: 'lee', label: `Leyendo «${event.title}»`, reading: [...reading] }); }
        setLive(previous => previous && (
        event.kind === 'stage' ? { ...previous, stage: event.stage, engine: event.engine ?? previous.engine, model: event.model ?? previous.model }
          : event.kind === 'sources' ? (onSources?.(event.sources.map(sourceId)), { ...previous, sources: event.sources })
          : event.kind === 'delta' ? { ...previous, text: previous.text + event.text }
          : event.kind === 'tool' ? { ...previous, steps: [...previous.steps, event.tool === 'search' ? `Buscó «${event.query}» · ${event.found.length} notas` : event.tool === 'inbox' ? `Consultó la Bandeja · ${event.count} correos` : event.tool === 'clients' ? `Consultó los clientes de Central · ${event.count}` : event.tool === 'rule_proposal' ? `Propuso la regla «${event.rule.name}»` : event.tool === 'read' ? `Leyó [${event.n}] ${event.title}` : 'Consultó tus datos'] }
          : previous));
      }, controller.signal);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : 'No se pudo responder.');
    } finally {
      abort.current = null;
      onThinking?.(null);
      if (id !== null && shownId.current === id) { try { setMessages((await getAssistantConversation(id)).messages); } catch { /* the error above is enough */ } }
      if (id === null || shownId.current === id) setLive(null);
      void refreshList();
    }
  }, [refreshList, onSources]);
  // A question asked from the brain's page starts a new conversation, once.
  useEffect(() => { if (question) { onQuestionTaken?.(); void send(question, null); } }, [question, onQuestionTaken, send]);
  // Only the message list scrolls (scrollIntoView would also move the page around it).
  useEffect(() => { const list = end.current?.parentElement; if (list) list.scrollTop = list.scrollHeight; }, [messages, live?.text, live?.stage, live?.steps.length]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault(); const text = draft.trim(); if (!text || live) return; setDraft('');
    if (proposals.answer(text, discreet)) return;  // a plain «sí» / «no» answers the rule Watson just proposed, without a model
    proposals.expire();
    if (!announced.answer(text, messages.length > 0 || current !== null)) void send(text, current);  // a plain «sí» / «no» answers the open announcement, without a model
  };
  // Enter sends; Shift+Enter is a new line (and Enter while composing an accent or IME text does nothing).
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } };
  const fresh = () => { abort.current?.abort(); setCurrent(null); setMessages([]); setLive(null); setError(''); proposals.clear(); onSources?.([]); if (embedded) setListOpen(false); };
  const sourceList = (sources: Source[]) => sources.length > 0 && <div className="sources">
    <span className="muted">Fuentes</span>
    <ol>{sources.map(source => <li key={source.n} value={source.n}><button onClick={() => onRead({ vault: source.source, note: source.ref })}>{source.title}</button><small>{source.folder || 'Raíz'}</small></li>)}</ol>
    {onShowOnGraph && <button className="button" onClick={() => onShowOnGraph(sources.map(sourceId))}>Ver en el cerebro</button>}
  </div>;
  const name = persona?.name ?? 'Watson';
  return <section className={`assistant${embedded ? ' embedded' : ''}`} aria-labelledby="assistant-title">
    {listOpen && <aside className="assistant-list" aria-label="Conversaciones">
      <button className="button primary" onClick={fresh}>Conversación nueva</button>
      {listError ? <LoadError message={listError} onRetry={refreshList}/> : !conversations ? <Loading label="Cargando conversaciones" lines={4}/>
        : !conversations.length ? <p className="muted">Aún no hay conversaciones.</p>
        : <ul>{conversations.map(item => <li key={item.id}><button aria-current={item.id === current ? 'true' : undefined} onClick={() => void open(item.id)}>
          <strong>{item.title}</strong><small>{new Date(item.updated_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</small>
        </button></li>)}</ul>}
    </aside>}
    <div className="assistant-main">
      <header className="assistant-head">
        <div><div className="eyebrow">ASISTENTE</div><h1 id="assistant-title">{name}</h1>
          {persona && <p className="muted">{persona.conveys}. Inspirado en {persona.origin}.</p>}</div>
        {embedded && <div className="actions"><button className="button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Conversaciones</button><button className="button" onClick={fresh}>Nueva</button></div>}
        <span className={`chip ${engine?.active ? 'good' : engine ? 'bad' : ''}`} role="status">
          {!engine ? 'Comprobando motor…' : engine.active ? `${engineName(engine.active)} · ${modelName(engine.model)}` : 'Sin motor disponible'}</span>
      </header>
      <div className="assistant-messages" aria-live="polite">
        <Announcements name={persona?.name ?? 'Watson'} items={announced.items} note={announced.note} decide={announced.decide} ready={announced.ready} filed={announced.filed} discreet={discreet}/>
        {loading ? <Loading label="Abriendo la conversación"/> : !messages.length && !live ? <div className="assistant-empty">
          <h2>¿Qué quieres saber de tu cerebro?</h2>
          <p>{name} busca en tus notas normales, responde con el motor de Claude y cita lo que ha usado. También te avisa de lo que espera en la Bandeja. Solo lee: no envía ni cambia nada, y lo que propone (por ejemplo, una regla del correo) solo se crea si lo confirmas.</p>
        </div> : messages.map((message, index) => <article key={index} className={`assistant-message ${message.role}${message.failed ? ' failed' : ''}`}>
          <strong>{message.role === 'user' ? 'Tú' : name}</strong>
          {message.role === 'user' ? <p>{message.content}</p> : <Markdown source={message.content} resolve={noLinks}/>}
          {message.failed && <small className="muted">Sin respuesta: el motor falló. Puedes repetir la pregunta.</small>}
          {message.role === 'assistant' && <small className="muted">Respondió {engineName(message.engine)}{message.model ? ` · ${modelName(message.model)}` : ''}</small>}
          {message.role === 'assistant' && sourceList(message.sources)}
        </article>)}
        {live && <>
          <article className="assistant-message user"><strong>Tú</strong><p>{live.question}</p></article>
          <article className="assistant-message assistant" aria-busy="true"><strong>{name}</strong>
            {live.steps.length > 0 && <ol className="assistant-steps">{live.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
            {live.text ? <Markdown source={live.text} resolve={noLinks}/> : <p className="muted">{live.stage ? stageLabels[live.stage] : 'Enviando…'}</p>}
            {live.engine && <small className="muted">{stageLabels.responde.replace('…', '')} con {engineName(live.engine)}{live.model ? ` · ${modelName(live.model)}` : ''}</small>}
            {sourceList(live.sources)}
          </article>
        </>}
        <RuleProposals state={proposals} discreet={discreet}/>
        {error && <LoadError message={error}/>}
        <div ref={end}/>
      </div>
      <form className="assistant-form" onSubmit={submit}>
        <label htmlFor="assistant-input" className="visually-hidden">Pregunta para {name}</label>
        <textarea id="assistant-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keys} maxLength={8000}
          placeholder={`Pregunta a ${name}…`} aria-keyshortcuts="Enter"/>
        <div className="actions">
          {live ? <button type="button" className="button" onClick={() => abort.current?.abort()}>Detener</button>
            : <button className="button primary" disabled={!draft.trim()}>Enviar</button>}
          <small className="muted">Enter envía · Mayús + Enter, nueva línea</small>
        </div>
      </form>
    </div>
  </section>;
}
