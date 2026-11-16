import { getTts, speakPiece, warmVoice, type TtsNow } from '../api/core';
import { advance, fresh, type Progress } from './voice-pieces';

/** Plays Watson's answers aloud (1.7). With VoiceStudio, piece by piece: the next one is prepared while one plays,
 * and the first starts as soon as the first sentence is written. If VoiceStudio fails, the rest is said with the
 * macOS voice and the problem is kept for Ajustes › Voz. With macOS, the whole answer at the end, as before. */

type Turn = { progress: Progress; queue: string[]; next: number; final: boolean; stopped: boolean;
  ready: Map<number, Promise<string>>; abort: AbortController; wake?: () => void; audio?: HTMLAudioElement; urls: string[] };

let voice: TtsNow | null = null;
let asked: Promise<void> | null = null;
let turn: Turn | null = null;
let onSpeaking: (now: boolean) => void = () => undefined;
export let lastProblem: string | null = null;

/** What speaks now, read again from the core (after a change in Ajustes, or at most once a minute). */
export function refreshVoice(): Promise<void> {
  // While AgoraOne opens VoiceStudio, read again in a few seconds so its voice is used as soon as it is up.
  asked = getTts().then(view => { voice = view.now; lastProblem = view.now.problem; if (view.opening) readAt = Date.now() - 55_000; }).catch(() => { voice = null; });
  return asked;
}
let readAt = 0;
const current = async () => { if (!asked || Date.now() - readAt > 60_000) { readAt = Date.now(); void refreshVoice(); } await asked; return voice; };

function macSpeak(text: string, done: () => void) {
  if (typeof speechSynthesis === 'undefined' || !text) { done(); return; }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'es-ES';
  const voices = speechSynthesis.getVoices();
  const chosen = (voice?.macVoice && voices.find(v => v.name === voice!.macVoice)) || voices.find(v => v.lang === 'es-ES' && v.localService) || voices.find(v => v.lang.startsWith('es'));
  if (chosen) utterance.voice = chosen;
  utterance.rate = voice?.speed ?? 1;
  utterance.onend = done; utterance.onerror = done;
  speechSynthesis.speak(utterance);
}

const prepare = (t: Turn, index: number) => {
  if (index < t.queue.length && !t.ready.has(index)) {
    const made = speakPiece(t.queue[index], t.abort.signal).then(url => { t.urls.push(url); return url; });
    made.catch(() => undefined);  // a piece prepared ahead and never played (silenced) is no unhandled error
    t.ready.set(index, made);
  }
  return t.ready.get(index);
};
const waitMore = (t: Turn) => new Promise<void>(resolve => { t.wake = resolve; });
const play = (t: Turn, url: string) => new Promise<void>(resolve => {
  const audio = new Audio(url);
  audio.playbackRate = voice?.speed ?? 1;
  t.audio = audio;
  audio.onended = () => resolve(); audio.onerror = () => resolve();
  void audio.play().catch(() => resolve());
});

async function run(t: Turn) {
  const now = await current();
  if (t.stopped) return;
  if (now?.engine === 'voicestudio') warmVoice().catch(() => undefined);
  if (now?.engine !== 'voicestudio') {
    while (!t.final && !t.stopped) await waitMore(t);
    if (!t.stopped) macSpeak(t.queue.join(' '), () => { if (turn === t) finish(t); });
    return;
  }
  while (!t.stopped) {
    if (t.next >= t.queue.length) { if (t.final) break; await waitMore(t); continue; }
    const url = prepare(t, t.next);
    prepare(t, t.next + 1);
    try {
      const ready = await url!;
      if (t.stopped) break;
      await play(t, ready);
      t.next += 1;
    } catch {
      if (t.stopped) break;
      lastProblem = 'VoiceStudio no respondió: Watson siguió con la voz de macOS.';
      while (!t.final && !t.stopped) await waitMore(t);
      if (!t.stopped) macSpeak(t.queue.slice(t.next).join(' '), () => { if (turn === t) finish(t); });
      return;
    }
  }
  if (turn === t) finish(t);
}

function finish(t: Turn) {
  t.stopped = true;
  t.abort.abort();
  t.audio?.pause();
  t.urls.forEach(url => URL.revokeObjectURL(url));
  if (turn === t) { turn = null; onSpeaking(false); }
}

export const player = {
  active: () => turn !== null,
  begin(setSpeaking: (now: boolean) => void) {
    if (turn) finish(turn);
    onSpeaking = setSpeaking;
    turn = { progress: fresh(), queue: [], next: 0, final: false, stopped: false, ready: new Map(), abort: new AbortController(), urls: [] };
    onSpeaking(true);
    void run(turn);
  },
  /** The answer so far (or final): the new whole sentences join the queue, up to the spoken limit. */
  feed(text: string, final: boolean) {
    const t = turn;
    if (!t || t.final) return;
    const { next, add } = advance(t.progress, text, final);
    t.progress = next;
    t.queue.push(...add);
    t.final = next.final;
    t.wake?.();
  },
  stop() {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (turn) finish(turn);
  },
};
