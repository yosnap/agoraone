import { useSyncExternalStore } from 'react';
import { askAssistant, getAssistantConversation, type AssistantEvent, type AssistantMessage, type Delegated, type Source, type Stage } from '../api/core';
import { play } from '../sound/sound';
import { answerSoFar, beginAnswer, speak } from './speech';
import { toolStep } from './assistant-labels';

/** What the chat shows while Watson answers. */
export type Live = { question: string; stage: Stage | null; sources: Source[]; text: string; engine?: string; model?: string; steps: string[] };
/** One answer on its way, kept outside the chat's components: leaving the chat (another section, another
 * conversation) does not stop it, and coming back shows where it is or how it ended. `events` keeps what the
 * tools did, so the proposals made while the chat was closed still open their cards (`takeEvents` hands each one
 * to a chat on screen once). */
export type Turn = {
  conversation: number; live: Live; events: AssistantEvent[]; reading: string[];
  done: boolean; error: string; messages: AssistantMessage[] | null;
};

let turns = new Map<number, Turn>();
const stops = new Map<number, AbortController>();
const shown = new Map<number, number>();  // how many events of each turn a chat has taken
const listeners = new Set<() => void>();
const notify = () => { turns = new Map(turns); listeners.forEach(listener => listener()); };
const change = (conversation: number, update: (turn: Turn) => Turn) => {
  const turn = turns.get(conversation);
  if (turn) { turns.set(conversation, update(turn)); notify(); }
};

export function useLiveTurns() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => turns);
}

/** The events of this turn no chat has taken yet; each is handed out once. */
export function takeEvents(conversation: number): AssistantEvent[] {
  const events = turns.get(conversation)?.events ?? [];
  const fresh = events.slice(shown.get(conversation) ?? 0);
  shown.set(conversation, events.length);
  return fresh;
}

/** The chat on screen has taken this finished turn: it is forgotten. */
export function forgetTurn(conversation: number) {
  if (turns.get(conversation)?.done) { turns.delete(conversation); shown.delete(conversation); notify(); }
}

/** «Detener»: the answer in this conversation stops (the core then keeps the question as unanswered). */
export function stopTurn(conversation: number) { stops.get(conversation)?.abort(); }


/** Asks Watson and follows the answer to its end whatever the screen does. True when it was answered. */
export async function startTurn(conversation: number, question: string, delegated?: Delegated, spoken = false): Promise<boolean> {
  shown.delete(conversation);
  turns.set(conversation, { conversation, live: { question, stage: null, sources: [], text: '', steps: [] }, events: [], reading: [], done: false, error: '', messages: null });
  notify();
  play('send');
  // The voice gets ready now and starts with the first whole sentence while the rest is written.
  beginAnswer(spoken);
  const controller = new AbortController();
  stops.set(conversation, controller);
  let soFar = '';
  let ok = false;
  let error = '';
  try {
    await askAssistant(conversation, question, event => {
      if (event.kind === 'delta') answerSoFar(soFar += event.text);
      if (event.kind === 'done') play('receive');
      change(conversation, turn => {
        const live = turn.live;
        const reading = event.kind === 'tool' && event.tool === 'read' ? [...turn.reading, event.id] : turn.reading;
        return { ...turn, reading, events: [...turn.events, event], live:
          event.kind === 'stage' ? { ...live, stage: event.stage, engine: event.engine ?? live.engine, model: event.model ?? live.model }
          : event.kind === 'sources' ? { ...live, sources: event.sources }
          : event.kind === 'delta' ? { ...live, text: live.text + event.text }
          : event.kind === 'tool' ? { ...live, steps: [...live.steps, toolStep(event)] }
          : live };
      });
    }, controller.signal, delegated);
    ok = true;
  } catch (failure) {
    if (!(failure instanceof DOMException && failure.name === 'AbortError')) error = failure instanceof Error ? failure.message : 'No se pudo responder.';
  } finally { stops.delete(conversation); }
  let messages: AssistantMessage[] | null = null;
  let spokeFinal = false;
  try {
    messages = (await getAssistantConversation(conversation)).messages;
    const last = messages.at(-1);
    if (ok && last?.role === 'assistant' && !last.failed) { speak(last.content, spoken); spokeFinal = true; }
  } catch { /* the chat reads the conversation again when it opens it */ }
  if (!spokeFinal) speak('', false);  // closes the answer begun (an error): nothing more is said
  change(conversation, turn => ({ ...turn, done: true, error, messages }));
  return ok;
}
