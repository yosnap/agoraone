import { useSyncExternalStore } from 'react';
import { askAssistant, getAssistantConversation, type AssistantEvent, type AssistantMessage, type Delegated, type Source, type Stage } from '../api/core';
import { play } from '../sound/sound';
import { answerSoFar, beginAnswer, speak } from './speech';
import { toolStep } from './assistant-labels';

/** What the chat shows while Watson answers. */
export type Live = { question: string; stage: Stage | null; sources: Source[]; text: string; engine?: string; model?: string; steps: string[] };
/** One answer on its way, kept outside the chat's components: leaving the chat (another section, another
 * conversation) does not stop it, and coming back shows where it is or how it ended. `events` keeps what the
 * stages and tools did (not the text, which is in `live`), so a chat that opens the conversation later still opens
 * the proposals' cards: each chat counts for itself how many it has taken. */
export type Turn = {
  id: number; conversation: number; live: Live; events: AssistantEvent[]; reading: string[];
  done: boolean; error: string; messages: AssistantMessage[] | null; finishedAt: number;
};

const KEEP_FINISHED = 5;  // answers finished while no chat looked at them, kept for when it opens them
let turns = new Map<number, Turn>();
let counter = 0;
const stops = new Map<number, AbortController>();
const listeners = new Set<() => void>();
const notify = () => { turns = new Map(turns); listeners.forEach(listener => listener()); };
// Only the turn that started it may change it.
const change = (conversation: number, id: number, update: (turn: Turn) => Turn) => {
  const turn = turns.get(conversation);
  if (turn?.id === id) { turns.set(conversation, update(turn)); notify(); }
};

export function useLiveTurns() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => turns);
}

/** The answer of this conversation, on its way or finished and not yet taken. */
export const turnOf = (conversation: number) => turns.get(conversation);

/** The chat on screen has taken this finished turn: it is forgotten. */
export function forgetTurn(conversation: number) {
  if (turns.get(conversation)?.done) { turns.delete(conversation); notify(); }
}

/** «Detener»: the answer in this conversation stops (the core then keeps the question as unanswered). */
export function stopTurn(conversation: number) { stops.get(conversation)?.abort(); }

/** The conversation Watson is answering now, if any: one answer at a time, so its voice and sounds never mix. */
export function answeringIn(): number | null {
  for (const turn of turns.values()) if (!turn.done) return turn.conversation;
  return null;
}

/** Asks Watson and follows the answer to its end whatever the screen does. True when it was answered; false at once
 * when another answer is still on its way. */
export async function startTurn(conversation: number, question: string, delegated?: Delegated, spoken = false): Promise<boolean> {
  if (answeringIn() !== null) return false;
  const id = ++counter;
  turns.set(conversation, { id, conversation, live: { question, stage: null, sources: [], text: '', steps: [] }, events: [], reading: [], done: false, error: '', messages: null, finishedAt: 0 });
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
      change(conversation, id, turn => {
        const live = turn.live;
        if (event.kind === 'delta') return { ...turn, live: { ...live, text: live.text + event.text } };
        const reading = event.kind === 'tool' && event.tool === 'read' ? [...turn.reading, event.id] : turn.reading;
        return { ...turn, reading, events: [...turn.events, event], live:
          event.kind === 'stage' ? { ...live, stage: event.stage, engine: event.engine ?? live.engine, model: event.model ?? live.model }
          : event.kind === 'sources' ? { ...live, sources: event.sources }
          : event.kind === 'tool' ? { ...live, steps: [...live.steps, toolStep(event)] }
          : live };
      });
    }, controller.signal, delegated);
    ok = true;
  } catch (failure) {
    if (!(failure instanceof DOMException && failure.name === 'AbortError')) error = failure instanceof Error ? failure.message : 'No se pudo responder.';
  } finally { if (stops.get(conversation) === controller) stops.delete(conversation); }
  let messages: AssistantMessage[] | null = null;
  let spokeFinal = false;
  try {
    messages = (await getAssistantConversation(conversation)).messages;
    const last = messages.at(-1);
    if (ok && last?.role === 'assistant' && !last.failed) { speak(last.content, spoken); spokeFinal = true; }
  } catch { /* the chat reads the conversation again when it opens it */ }
  if (!spokeFinal) speak('', false);  // closes the answer begun (an error): nothing more is said
  change(conversation, id, turn => ({ ...turn, done: true, error, messages, finishedAt: Date.now() }));
  // Answers nobody came back for are kept only for a while: the oldest go first.
  const finished = [...turns.values()].filter(turn => turn.done).sort((a, b) => a.finishedAt - b.finishedAt);
  if (finished.length > KEEP_FINISHED) { for (const turn of finished.slice(0, finished.length - KEEP_FINISHED)) turns.delete(turn.conversation); notify(); }
  return ok;
}
