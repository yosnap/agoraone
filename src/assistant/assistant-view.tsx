import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RuleProposals, useProposals } from './rule-proposals';
import { DictationButton } from '../ui/dictation-button';
import { isYes, quickCommand, type QuickResult } from './quick-commands';
import { NoteProposals, useNoteProposals } from './note-proposals';
import { EventProposals, useEventProposals } from './event-proposals';
import { QuoteProposals, useQuoteProposals } from './quote-proposals';
import { CleanupProposals, useCleanupProposals } from './cleanup-proposals';
import { speak, stopSpeaking, useSpeaking } from './speech';

// The conversation last open (its number only, in this browser), opened again when coming back to the chat.
const LAST = 'agora-watson-conversation';
const readLast = () => { try { const n = Number(localStorage.getItem(LAST)); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } };
const writeLast = (id: number | null) => { try { if (id === null) localStorage.removeItem(LAST); else localStorage.setItem(LAST, String(id)); } catch { /* not remembered this time */ } };
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
  // What the microphone is doing, shown live in the panel (1.4): hearing, then turning it into text.
  const pendingQuick = useRef<(() => Promise<QuickResult>) | null>(null);
  // Whether the question being answered was spoken: Watson then answers aloud too (Ajustes › Voz).
  const spokenTurn = useRef(false);
  const [hearing, setHearing] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
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
  const notes = useNoteProposals();
  const events = useEventProposals();
  const quotes = useQuoteProposals();
  const cleanups = useCleanupProposals();
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
    setCurrent(id); setLive(null); setError(''); setLoading(true); proposals.clear(); writeLast(id); shownId.current = id;
    if (embedded) setListOpen(false);
    try { const found = (await getAssistantConversation(id)).messages; setMessages(found); onSources?.(lastSources(found)); }
    catch (failure) { setMessages([]); setCurrent(null); writeLast(null); setError(failure instanceof Error ? failure.message : 'No se pudo abrir la conversación.'); }
    finally { setLoading(false); }
  }, []);
  // Coming back to the chat opens the last conversation; only «Nueva» starts another. Leaving stops Watson's voice.
  useEffect(() => {
    const last = readLast();
    if (last !== null) void open(last);
    return () => stopSpeaking();
  }, [open]);
  const talking = useSpeaking();
  const send = useCallback(async (text: string, into: number | null) => {
    let id = into;
    setError('');
    try {
      if (id === null) { id = (await createAssistantConversation()).id; shownId.current = id; setCurrent(id); writeLast(id); setMessages([]); }
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
        else if (event.kind === 'tool' && event.tool === 'note_proposal') notes.add(event.id, event.note);
        else if (event.kind === 'tool' && event.tool === 'event_proposal') events.add(event.id, event.event);
        else if (event.kind === 'tool' && event.tool === 'quote_proposal') quotes.add(event.id, event.quote);
        else if (event.kind === 'tool' && event.tool === 'cleanup_proposal') cleanups.add(event.id, event.action, event.messages);
        else if (event.kind === 'tool' && event.tool === 'read') { reading.push(event.id); onThinking?.({ stage: 'lee', label: `Leyendo «${event.title}»`, reading: [...reading] }); }
        setLive(previous => previous && (
        event.kind === 'stage' ? { ...previous, stage: event.stage, engine: event.engine ?? previous.engine, model: event.model ?? previous.model }
          : event.kind === 'sources' ? (onSources?.(event.sources.map(sourceId)), { ...previous, sources: event.sources })
          : event.kind === 'delta' ? { ...previous, text: previous.text + event.text }
          : event.kind === 'tool' ? { ...previous, steps: [...previous.steps, event.tool === 'search' ? `Buscó «${event.query}» · ${event.found.length} notas` : event.tool === 'inbox' ? `Consultó la Bandeja · ${event.count} correos` : event.tool === 'clients' ? `Consultó los clientes de Central · ${event.count}` : event.tool === 'rule_proposal' ? `Propuso la regla «${event.rule.name}»` : event.tool === 'note_proposal' ? `Propuso la nota «${event.note.title}»` : event.tool === 'event_proposal' ? `Propuso el evento «${event.event.title}»` : event.tool === 'quote_proposal' ? `Propuso el presupuesto «${event.quote.title}»` : event.tool === 'cleanup_proposal' ? `Preparó ${event.messages.length} correos para ${event.action === 'trash' ? 'la Papelera' : 'archivar'}` : event.tool === 'read' ? `Leyó [${event.n}] ${event.title}` : 'Consultó tus datos'] }
          : previous));
      }, controller.signal);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : 'No se pudo responder.');
    } finally {
      abort.current = null;
      onThinking?.(null);
      if (id !== null && shownId.current === id) {
        try {
          const found = (await getAssistantConversation(id)).messages;
          setMessages(found);
          const last = found.at(-1);
          if (last?.role === 'assistant' && !last.failed) speak(last.content, spokenTurn.current);
        } catch { /* the error above is enough */ }
      }
      if (id === null || shownId.current === id) setLive(null);
      void refreshList();
    }
  }, [refreshList, onSources]);
  // A question asked from the brain's page starts a new conversation, once.
  useEffect(() => { if (question) { onQuestionTaken?.(); void send(question, null); } }, [question, onQuestionTaken, send]);
  // Only the message list scrolls (scrollIntoView would also move the page around it).
  useEffect(() => { const list = end.current?.parentElement; if (list) list.scrollTop = list.scrollHeight; }, [messages, live?.text, live?.stage, live?.steps.length]);
  // `spoken`: what the microphone heard, added to what was typed and sent at once.
  const submit = (event?: FormEvent, spoken?: string) => {
    event?.preventDefault();
    const text = (spoken === undefined ? draft : (draft.trim() ? `${draft.trimEnd()} ${spoken}` : spoken)).trim();
    if (!text || live) return; setDraft('');
    spokenTurn.current = spoken !== undefined;
    stopSpeaking();
    if (proposals.answer(text, discreet)) return;  // a plain «sí» / «no» answers the rule Watson just proposed, without a model
    proposals.expire();
    // «Pon…», «pausa», «siguiente», «abre…»: done at once, without a model, and noted in the chat (not saved).
    // An app outside the allowed list waits for a «sí» right after; anything else drops that question.
    const waiting = pendingQuick.current;
    pendingQuick.current = null;
    const quick = waiting && isYes(text) ? waiting : quickCommand(text);
    if (quick) {
      const at = new Date().toISOString();
      setMessages(current => [...current, { role: 'user', content: text, sources: [], engine: null, model: null, failed: false, created_at: at }]);
      void quick().then(result => {
        pendingQuick.current = result.confirm ?? null;
        speak(result.reply, spokenTurn.current);
        setMessages(current => [...current, { role: 'assistant', content: result.reply, sources: [], engine: 'quick', model: null, failed: result.failed, created_at: new Date().toISOString() }]);
      });
      return;
    }
    if (!announced.answer(text, messages.length > 0 || current !== null)) void send(text, current);  // a plain «sí» / «no» answers the open announcement, without a model
  };
  // Enter sends; Shift+Enter is a new line (and Enter while composing an accent or IME text does nothing).
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } };
  const fresh = () => { abort.current?.abort(); stopSpeaking(); writeLast(null); setCurrent(null); setMessages([]); setLive(null); setError(''); proposals.clear(); onSources?.([]); if (embedded) setListOpen(false); };
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
        {embedded && <div className={`watson-orb ${hearing === 'recording' ? 'hearing' : live ? 'busy' : ''}`} aria-hidden="true"><i/><i/><i/></div>}
        <div>{!embedded && <div className="eyebrow">ASISTENTE</div>}<h1 id="assistant-title">{name}</h1>
          {embedded ? <p className="watson-state" role="status">{hearing === 'recording' ? 'Escuchando… (en este Mac)' : hearing === 'transcribing' ? 'Pasando tu voz a texto…'
            : live ? (live.stage ? stageLabels[live.stage] : 'Enviando…') : 'Listo · escribe o pulsa el micrófono'}</p>
            : persona && <p className="muted">{persona.conveys}. Inspirado en {persona.origin}.</p>}</div>
        {embedded && <div className="actions"><button className="button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Conversaciones</button><button className="button" onClick={fresh}>Nueva</button></div>}
        {talking && <button type="button" className="button watson-hush" onClick={stopSpeaking} aria-label="Callar a Watson">■ Callar</button>}
        <span className={`chip ${engine?.active ? 'good' : engine ? 'bad' : ''}`} role="status">
          {!engine ? 'Comprobando motor…' : engine.active ? `${engineName(engine.active)} · ${modelName(engine.model)}` : 'Sin motor disponible'}</span>
      </header>
      <div className="assistant-messages" aria-live="polite">
        <Announcements name={persona?.name ?? 'Watson'} items={announced.items} note={announced.note} decide={announced.decide} ready={announced.ready} filed={announced.filed} discreet={discreet}/>
        {loading ? <Loading label="Abriendo la conversación"/> : !messages.length && !live && embedded ? <p className="watson-empty muted">
          Pregúntale a {name} o habla con el micrófono. Busca en tus notas normales, cita lo que usa y solo cambia algo si lo confirmas.</p>
        : !messages.length && !live ? <div className="assistant-empty">
          <h2>¿Qué quieres saber de tu cerebro?</h2>
          <p>{name} busca en tus notas normales, responde con el motor de Claude y cita lo que ha usado. También te avisa de lo que espera en la Bandeja. Solo lee: no envía ni cambia nada, y lo que propone (por ejemplo, una regla del correo) solo se crea si lo confirmas.</p>
        </div> : messages.map((message, index) => <article key={index} className={`assistant-message ${message.role}${message.failed ? ' failed' : ''}`}>
          <strong>{message.role === 'user' ? 'Tú' : name}</strong>
          {message.role === 'user' ? <p>{message.content}</p> : <Markdown source={message.content} resolve={noLinks}/>}
          {message.failed && message.engine !== 'quick' && <small className="muted">Sin respuesta: el motor falló. Puedes repetir la pregunta.</small>}
          {message.role === 'assistant' && message.engine === 'quick' && <small className="muted">Orden rápida, sin modelo</small>}
          {message.role === 'assistant' && message.engine !== 'quick' && <small className="muted">Respondió {engineName(message.engine)}{message.model ? ` · ${modelName(message.model)}` : ''}</small>}
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
        {(hearing === 'recording' || hearing === 'transcribing') && <div className="watson-heard" aria-live="polite">
          {hearing === 'recording' ? '«…»' : 'Transcribiendo…'}<small>{hearing === 'recording' ? 'oyendo · se transcribe en este Mac' : 'en este Mac, con whisper'}</small></div>}
        <RuleProposals state={proposals} discreet={discreet}/>
        <NoteProposals state={notes}/>
        <EventProposals state={events}/>
        <QuoteProposals state={quotes}/>
        <CleanupProposals state={cleanups} discreet={discreet}/>
        {error && <LoadError message={error}/>}
        <div ref={end}/>
      </div>
      <form className="assistant-form" onSubmit={submit}>
        <label htmlFor="assistant-input" className="visually-hidden">Pregunta para {name}</label>
        <textarea id="assistant-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keys} maxLength={8000}
          placeholder={embedded ? 'Escribe o habla…' : `Pregunta a ${name}…`} aria-keyshortcuts="Enter" rows={embedded ? 1 : undefined}/>
        <div className="actions">
          <DictationButton disabled={Boolean(live)} onText={spoken => submit(undefined, spoken)} onPhase={phase => { if (phase === 'starting') stopSpeaking(); setHearing(phase); }} big={embedded}/>
          {live ? <button type="button" className="button" onClick={() => abort.current?.abort()}>Detener</button>
            : !embedded && <button className="button primary" disabled={!draft.trim()}>Enviar</button>}
          {!embedded && <small className="muted">Enter envía · Mayús + Enter, nueva línea</small>}
        </div>
      </form>
    </div>
  </section>;
}
