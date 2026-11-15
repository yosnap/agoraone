import { useSyncExternalStore } from 'react';
import { sendMeetingPiece, startMeeting, stopMeeting, type Level } from '../api/core';

/** The meeting being recorded, kept outside any view so it goes on while the user moves between sections;
 * the left rail shows it all the time. Your microphone is recorded here and sent to the core every few
 * seconds, in order (that is also how the core knows the screen is still recording: if the pieces stop, it
 * stops by itself). The system's audio is recorded by the core. Nothing starts without the button. */
const PIECE_MS = 5_000;
const BITRATE = 32_000;
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

export type RecorderState = {
  phase: 'idle' | 'starting' | 'recording' | 'stopping';
  meetingId: number | null; title: string; startedAt: number | null; note: string | null; error: string; finished: number;
  /** Seconds recorded, updated every second while recording. */ seconds: number;
  /** How loud your microphone is now, 0 to 1 (measured here, never sent). */ level: number;
  confidentiality: Level;
};
let state: RecorderState = { phase: 'idle', meetingId: null, title: '', startedAt: null, note: null, error: '', finished: 0, seconds: 0, level: 0, confidentiality: 'normal' };
const listeners = new Set<() => void>();
const set = (changes: Partial<RecorderState>) => { state = { ...state, ...changes }; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useMeetingRecorder = () => useSyncExternalStore(subscribe, () => state);

let media: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let queue: Promise<void> = Promise.resolve();
let failed = false;
let clock = 0;
let meter = 0;
let audio: AudioContext | null = null;

const release = () => {
  window.clearInterval(clock); window.clearInterval(meter);
  void audio?.close().catch(() => undefined); audio = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null; media = null;
};
// The microphone's loudness for the brain's meter: an analyser on the same stream, read four times a second.
function watchLevel(input: MediaStream) {
  try {
    audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(input).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    meter = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      set({ level: Math.min(1, Math.sqrt(sum / samples.length) * 4) });
    }, 250);
  } catch { /* no Web Audio here: the meter stays at zero */ }
}
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

export async function startRecording(title: string, confidentiality: Level, system: boolean) {
  if (state.phase !== 'idle') return;
  set({ phase: 'starting', error: '', note: null });
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { set({ phase: 'idle', error: 'Este equipo no permite grabar audio aquí.' }); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { set({ phase: 'idle', error: 'Sin permiso para el micrófono: dalo en los ajustes de privacidad del sistema y vuelve a intentarlo.' }); return; }
  const type = TYPES.find(t => MediaRecorder.isTypeSupported(t));
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: BITRATE }); }
  catch { release(); set({ phase: 'idle', error: 'Este equipo no puede grabar audio aquí.' }); return; }
  let meeting;
  try { meeting = await startMeeting({ title, confidentiality, mic_type: recorder.mimeType || type || 'audio/webm', system }); }
  catch (failure) { release(); set({ phase: 'idle', error: message(failure, 'No se pudo empezar a grabar.') }); return; }
  const id = meeting.id;
  failed = false;
  queue = Promise.resolve();
  recorder.ondataavailable = event => {
    if (!event.data.size || failed) return;
    const piece = event.data;
    queue = queue.then(() => sendMeetingPiece(id, piece)).catch(failure => {
      // The core stopped it (left alone too long, too long overall) or cannot keep it: stop here too.
      failed = true;
      set({ error: message(failure, 'No se pudo guardar el audio.') });
      if (media?.state === 'recording') media.stop();
    });
  };
  recorder.onstop = () => {
    release();
    set({ phase: 'stopping' });
    void queue.then(() => stopMeeting(id)).then(done => set({ note: done.note }), failure => set({ error: message(failure, 'No se pudo cerrar la grabación.') }))
      .finally(() => set({ phase: 'idle', meetingId: null, startedAt: null, finished: Date.now(), level: 0 }));
  };
  try { recorder.start(PIECE_MS); }
  catch { release(); await stopMeeting(id).catch(() => undefined); set({ phase: 'idle', error: 'Este equipo no puede grabar audio aquí.' }); return; }
  media = recorder;
  const began = Date.now();
  set({ phase: 'recording', meetingId: id, title: meeting.title, startedAt: began, note: meeting.note, seconds: 0, level: 0, confidentiality });
  watchLevel(stream!);
  clock = window.setInterval(() => set({ seconds: Math.floor((Date.now() - began) / 1000) }), 1000);
}

export function stopRecording() {
  if (media?.state === 'recording') media.stop();
}

// The last choices of the form, so the rail's button records the same way with one press (per viewer only).
const CHOICE = 'agora-meeting-choice';
type Choice = { confidentiality: Level; system: boolean };
export function lastChoice(): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICE) || '{}');
    return { confidentiality: ['normal', 'local_only', 'private'].includes(saved.confidentiality) ? saved.confidentiality : 'normal', system: saved.system !== false };
  } catch { return { confidentiality: 'normal', system: true }; }
}
export function rememberChoice(choice: Choice) {
  try { localStorage.setItem(CHOICE, JSON.stringify(choice)); } catch { /* private window: nothing to remember */ }
}
/** One press from anywhere: start with the last choices, or stop what is recording. */
export function toggleQuickRecording() {
  if (state.phase === 'recording') { stopRecording(); return; }
  if (state.phase !== 'idle') return;
  const choice = lastChoice();
  void startRecording('', choice.confidentiality, choice.system);
}
