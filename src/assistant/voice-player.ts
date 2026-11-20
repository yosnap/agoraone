import { getTts, speakPiece, warmVoice, type TtsNow, type TtsView } from '../api/core';
import { advance, fresh, type Progress } from './voice-pieces';
import { systemVoiceOf } from '../ui/platform';

/** Plays Watson's answers aloud (1.7). With VoiceStudio, piece by piece: the next one is prepared while one plays,
 * and the first starts as soon as the first sentence is written. If VoiceStudio fails, the rest is said with the
 * macOS voice and the problem is kept for Ajustes › Voz. With macOS, the whole answer at the end, as before.
 * When VoiceStudio is wanted and its app is running or being opened, Watson waits for it (up to two minutes)
 * instead of speaking with macOS; when it is not open, macOS speaks and the panel says why (user's request,
 * 18/11/2026). */

type Turn = { progress: Progress; queue: string[]; next: number; final: boolean; stopped: boolean;
  ready: Map<number, Promise<string>>; abort: AbortController; wake?: () => void; audio?: HTMLAudioElement; urls: string[] };

let voice: TtsNow | null = null;
let view: TtsView | null = null;
let asked: Promise<void> | null = null;
let turn: Turn | null = null;
let onSpeaking: (now: boolean) => void = () => undefined;
export let lastProblem: string | null = null;

/** What speaks now, read again from the core (after a change in Ajustes, or at most once a minute). */
export function refreshVoice(): Promise<void> {
  // While AgoraOne opens VoiceStudio, read again in a few seconds so its voice is used as soon as it is up.
  asked = getTts().then(read => { view = read; voice = read.now; lastProblem = read.now.problem; if (read.opening) readAt = Date.now() - 55_000; }).catch(() => { view = null; voice = null; });
  return asked;
}
let readAt = 0;
// What the panel says about the voice while it speaks (waiting for VoiceStudio, or macOS in its place), or null.
let notice: string | null = null;
const noticeListeners = new Set<() => void>();
function setNotice(text: string | null) { if (notice !== text) { notice = text; noticeListeners.forEach(listener => listener()); } }
export const voiceNotice = { get: () => notice, subscribe(listener: () => void) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; } };
const WAIT_FOR_STUDIO = 120_000;
const pause = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
const studioWanted = (read: TtsView | null) => !!read && (read.settings.engine === 'voicestudio' || (read.settings.engine === 'auto' && read.installed));
const studioLoading = (read: TtsView | null) => studioWanted(read) && read!.voicestudio === null && (read!.opening || read!.running);

/** The voice for this answer: while VoiceStudio is wanted and still starting, wait for it; else what speaks now,
 * saying so in the panel when macOS speaks in VoiceStudio's place. */
async function settle(t: Turn): Promise<TtsNow | null> {
  await current();
  const limit = Date.now() + WAIT_FOR_STUDIO;
  while (!t.stopped && studioLoading(view) && Date.now() < limit) {
    setNotice('Esperando a que VoiceStudio esté listo para hablar…');
    await pause(2000);
    readAt = Date.now();
    await refreshVoice();
  }
  if (t.stopped) return voice;
  const instead = studioWanted(view) && voice?.engine !== 'voicestudio';
  setNotice(instead ? (view?.voicestudio === null ? `VoiceStudio no está abierto: Watson habla con la voz ${systemVoiceOf} hasta que arranque.` : voice?.problem ?? null) : null);
  return voice;
}
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
  const now = await settle(t);
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
      setNotice(lastProblem);
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
