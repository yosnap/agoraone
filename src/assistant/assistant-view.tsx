import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  askAssistant, createAssistantConversation, getAssistantConversation, getAssistantSettings, getEngines, getPersonas, listAssistantConversations,
  type AssistantMessage, type ConversationSummary, type Persona, type Source, type Stage,
} from '../api/core';
import { Markdown } from '../ui/markdown';
import { Loading, LoadError } from '../ui/load-state';
import type { NoteRef } from '../brain/note-reader';
import { engineName, modelName, stageLabels } from './assistant-labels';
import './assistant.css';

type Live = { question: string; stage: Stage | null; sources: Source[]; text: string; engine?: string; model?: string };
const noLinks = () => null;

/** Watson (or the chosen character): conversations kept in the brain, answers streamed with their real stages,
 * the engine and model that answered, and the notes cited, which open as books or light up on the graph. */
export function AssistantView({ question, onQuestionTaken, onRead, onShowOnGraph }: {
  question: string | null; onQuestionTaken: () => void; onRead: (note: NoteRef) => void; onShowOnGraph: (ids: string[]) => void;
}) {
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
    setCurrent(id); setLive(null); setError(''); setLoading(true);
    try { setMessages((await getAssistantConversation(id)).messages); }
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
      setLive({ question: text, stage: null, sources: [], text: '' });
      await askAssistant(id, text, event => setLive(previous => previous && (
        event.kind === 'stage' ? { ...previous, stage: event.stage, engine: event.engine ?? previous.engine, model: event.model ?? previous.model }
          : event.kind === 'sources' ? { ...previous, sources: event.sources }
          : event.kind === 'delta' ? { ...previous, text: previous.text + event.text } : previous)), controller.signal);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : 'No se pudo responder.');
    } finally {
      abort.current = null;
      if (id !== null && shownId.current === id) { try { setMessages((await getAssistantConversation(id)).messages); } catch { /* the error above is enough */ } }
      if (id === null || shownId.current === id) setLive(null);
      void refreshList();
    }
  }, [refreshList]);
  // A question asked from the brain's page starts a new conversation, once.
  useEffect(() => { if (question) { onQuestionTaken(); void send(question, null); } }, [question, onQuestionTaken, send]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages, live?.text, live?.stage]);
  const submit = (event?: FormEvent) => { event?.preventDefault(); const text = draft.trim(); if (!text || live) return; setDraft(''); void send(text, current); };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } };
  const fresh = () => { abort.current?.abort(); setCurrent(null); setMessages([]); setLive(null); setError(''); };
  const sourceList = (sources: Source[]) => sources.length > 0 && <div className="sources">
    <span className="muted">Fuentes</span>
    <ol>{sources.map(source => <li key={source.n} value={source.n}><button onClick={() => onRead({ vault: source.source, note: source.ref })}>{source.title}</button><small>{source.folder || 'Raíz'}</small></li>)}</ol>
    <button className="button" onClick={() => onShowOnGraph(sources.map(source => `${source.source}/${source.ref}`))}>Ver en el cerebro</button>
  </div>;
  const name = persona?.name ?? 'Watson';
  return <section className="assistant" aria-labelledby="assistant-title">
    <aside className="assistant-list" aria-label="Conversaciones">
      <button className="button primary" onClick={fresh}>Conversación nueva</button>
      {listError ? <LoadError message={listError} onRetry={refreshList}/> : !conversations ? <Loading label="Cargando conversaciones" lines={4}/>
        : !conversations.length ? <p className="muted">Aún no hay conversaciones.</p>
        : <ul>{conversations.map(item => <li key={item.id}><button aria-current={item.id === current ? 'true' : undefined} onClick={() => void open(item.id)}>
          <strong>{item.title}</strong><small>{new Date(item.updated_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</small>
        </button></li>)}</ul>}
    </aside>
    <div className="assistant-main">
      <header className="assistant-head">
        <div><div className="eyebrow">ASISTENTE</div><h1 id="assistant-title">{name}</h1>
          {persona && <p className="muted">{persona.conveys}. Inspirado en {persona.origin}.</p>}</div>
        <span className={`chip ${engine?.active ? 'good' : engine ? 'bad' : ''}`} role="status">
          {!engine ? 'Comprobando motor…' : engine.active ? `${engineName(engine.active)} · ${modelName(engine.model)}` : 'Sin motor disponible'}</span>
      </header>
      <div className="assistant-messages" aria-live="polite">
        {loading ? <Loading label="Abriendo la conversación"/> : !messages.length && !live ? <div className="assistant-empty">
          <h2>¿Qué quieres saber de tu cerebro?</h2>
          <p>{name} busca en tus notas normales, responde con el motor de Claude y cita lo que ha usado. En esta versión solo lee: no envía, crea ni cambia nada.</p>
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
            {live.text ? <Markdown source={live.text} resolve={noLinks}/> : <p className="muted">{live.stage ? stageLabels[live.stage] : 'Enviando…'}</p>}
            {live.engine && <small className="muted">{stageLabels.responde.replace('…', '')} con {engineName(live.engine)}{live.model ? ` · ${modelName(live.model)}` : ''}</small>}
            {sourceList(live.sources)}
          </article>
        </>}
        {error && <LoadError message={error}/>}
        <div ref={end}/>
      </div>
      <form className="assistant-form" onSubmit={submit}>
        <label htmlFor="assistant-input" className="visually-hidden">Pregunta para {name}</label>
        <textarea id="assistant-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keys} maxLength={8000}
          placeholder={`Pregunta a ${name}…`} aria-keyshortcuts="Meta+Enter Control+Enter"/>
        <div className="actions">
          {live ? <button type="button" className="button" onClick={() => abort.current?.abort()}>Detener</button>
            : <button className="button primary" disabled={!draft.trim()}>Enviar</button>}
          <small className="muted">⌘/Ctrl + Enter envía</small>
        </div>
      </form>
    </div>
  </section>;
}
