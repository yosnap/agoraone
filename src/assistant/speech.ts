/** Watson speaking its answers (1.5; voice to choose in 1.7): with the system's own voices or with VoiceStudio on
 * this Mac (voice-player.ts). Nothing is sent outside this computer. By default it speaks when it was spoken to;
 * the choice is per viewer. */
import { useSyncExternalStore } from 'react';
import { player, voiceNotice } from './voice-player';
import { MAX_SPOKEN, plainWords } from './voice-pieces';

export type VoiceMode = 'spoken' | 'always' | 'never';
// Whether Watson is speaking now, so the panel can offer to stop it.
let speaking = false;
const listeners = new Set<() => void>();
const setSpeaking = (now: boolean) => { if (speaking !== now) { speaking = now; listeners.forEach(listener => listener()); } };
export const useSpeaking = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => speaking);
/** What the panel says about Watson's voice (waiting for VoiceStudio, or macOS speaking in its place), or null. */
export const useVoiceNotice = () => useSyncExternalStore(voiceNotice.subscribe, voiceNotice.get);
const KEY = 'agora-watson-voice';
const MAX = MAX_SPOKEN;

export function voiceMode(): VoiceMode {
  try { const saved = localStorage.getItem(KEY); return saved === 'always' || saved === 'never' ? saved : 'spoken'; } catch { return 'spoken'; }
}
export function setVoiceMode(mode: VoiceMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* not remembered this time */ }
  if (mode === 'never') stopSpeaking();
}

/** Plain words: no Markdown, links or citation marks, cut at a sentence near the limit. */
export function speakable(text: string): string {
  const plain = plainWords(text);
  if (plain.length <= MAX) return plain;
  const cut = plain.slice(0, MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > MAX / 2 ? cut.slice(0, end + 1) : `${cut}…`;
}

const wants = (spokenTo: boolean) => { const mode = voiceMode(); return mode === 'always' || (mode === 'spoken' && spokenTo); };
// The answer being written: spoken, silenced by the user («Callar»: it stays silent until the next question), or none.
let answer: 'none' | 'spoken' | 'hushed' = 'none';

/** A question was sent: if Watson will speak the answer, the voice gets ready and starts with the first sentence
 * while the rest is still being written (with VoiceStudio; macOS speaks the whole answer at the end). */
export function beginAnswer(spokenTo: boolean) {
  player.stop();
  setSpeaking(false);
  answer = wants(spokenTo) ? 'spoken' : 'none';
  if (answer === 'spoken') player.begin(setSpeaking);
}
/** The answer as written so far. */
export const answerSoFar = (text: string) => player.feed(text, false);

/** The finished answer (or a quick command's reply): spoken, or finished if it was already being spoken. */
export function speak(text: string, spokenTo: boolean) {
  if (answer !== 'none') {  // the end of an answer already begun: finished, never started again (nor after «Callar»)
    const silenced = answer === 'hushed';
    answer = 'none';
    if (!silenced) player.feed(text, true);
    return;
  }
  if (wants(spokenTo)) { player.begin(setSpeaking); player.feed(text, true); }
}

export function stopSpeaking() {
  if (answer === 'spoken') answer = 'hushed';
  player.stop();
  setSpeaking(false);
}

/** «Probar» in Ajustes: says this with the chosen voice, whatever the «responde hablando» choice is. */
export function tryVoice(text: string) {
  player.stop();
  answer = 'none';
  player.begin(setSpeaking);
  player.feed(text, true);
}
