/** Watson speaking its answers (1.5) with the system's own voices (the browser's speech synthesis: on this
 * computer, nothing sent anywhere). By default it speaks when it was spoken to; the choice is per viewer. */
import { useSyncExternalStore } from 'react';

export type VoiceMode = 'spoken' | 'always' | 'never';
// Whether Watson is speaking now, so the panel can offer to stop it.
let speaking = false;
const listeners = new Set<() => void>();
const setSpeaking = (now: boolean) => { if (speaking !== now) { speaking = now; listeners.forEach(listener => listener()); } };
export const useSpeaking = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => speaking);
const KEY = 'agora-watson-voice';
const MAX = 700;

export function voiceMode(): VoiceMode {
  try { const saved = localStorage.getItem(KEY); return saved === 'always' || saved === 'never' ? saved : 'spoken'; } catch { return 'spoken'; }
}
export function setVoiceMode(mode: VoiceMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* not remembered this time */ }
  if (mode === 'never') stopSpeaking();
}

/** Plain words: no Markdown, links or citation marks, cut at a sentence near the limit. */
export function speakable(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/\[[^\]]{1,40}\]/g, '').replace(/[*_#>`|~]/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= MAX) return plain;
  const cut = plain.slice(0, MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > MAX / 2 ? cut.slice(0, end + 1) : `${cut}…`;
}

export function speak(text: string, spokenTo: boolean) {
  const mode = voiceMode();
  if (mode === 'never' || (mode === 'spoken' && !spokenTo) || typeof speechSynthesis === 'undefined') return;
  const words = speakable(text);
  if (!words) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(words);
  utterance.lang = 'es-ES';
  const voice = speechSynthesis.getVoices().find(v => v.lang === 'es-ES' && v.localService) ?? speechSynthesis.getVoices().find(v => v.lang.startsWith('es'));
  if (voice) utterance.voice = voice;
  utterance.onend = () => setSpeaking(false);
  utterance.onerror = () => setSpeaking(false);
  setSpeaking(true);
  speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  setSpeaking(false);
}
