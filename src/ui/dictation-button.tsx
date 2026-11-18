import { useCallback, useRef, useState } from 'react';
import { transcribeVoice } from '../api/core';
import { useListenRequests } from '../assistant/listen';
import { moduleOn, useModules } from '../shell/modules';
import { hear, silence } from './silence';
import { play } from '../sound/sound';

const LIMIT_MS = 60_000;
const MAX_BYTES = 1024 * 1024; // what the server lets through
const BITRATE = 32_000; // whisper reads 16 kHz mono: a minute stays around 240 KB
// The first type the WebView can record: WebKit (macOS, Linux) records MP4/AAC, Chromium's WebView2 WebM/Opus.
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
type State = 'idle' | 'starting' | 'recording' | 'transcribing';

const Mic = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
  <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>;

/** Speaking instead of typing (user's decision, 15/11/2026): press the microphone to record (up to a minute),
 * press again to stop; the words, transcribed on this machine by whisper.cpp, are sent as the message, after
 * anything already typed. Started hands-free («Oye Watson», ⌃⌥W), it also stops by itself when the user pauses
 * after speaking, and drops it when nothing was said (silence.ts). The microphone closes when the button leaves the page, and stopping is never
 * disabled. */
export function DictationButton({ onText, disabled, onPhase, big = false }: {
  onText: (text: string) => void; disabled?: boolean;
  /** Told when it starts or stops hearing, so a panel can show «oyendo…» live. */ onPhase?: (phase: 'idle' | 'starting' | 'recording' | 'transcribing') => void;
  /** The large round microphone of Watson's panel. */ big?: boolean;
}) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timers = useRef<number[]>([]);
  const phase = useRef<State>('idle');
  const gone = useRef(false);
  const move = (next: State) => { phase.current = next; if (!gone.current) { setState(next); onPhase?.(next); } };
  const clear = () => { timers.current.forEach(t => window.clearTimeout(t)); timers.current = []; };
  const listening = useRef<{ context: AudioContext; timer: number } | null>(null);
  const release = () => {
    if (listening.current) { window.clearInterval(listening.current.timer); void listening.current.context.close().catch(() => undefined); listening.current = null; }
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  };
  // Hands-free: the microphone's loudness, ten times a second, decides when the message is over.
  const dropped = useRef(false);
  const watchSilence = (input: MediaStream) => {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(input).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let state = silence(Date.now());
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const { next, stop: end } = hear(state, Math.sqrt(sum / samples.length), Date.now());
        state = next;
        if (end) { dropped.current = end === 'nothing'; stop(); }
      }, 100);
      listening.current = { context, timer };
    } catch { /* no Web Audio here: it stops when pressed or at the minute, as before */ }
  };
  // Leaving the page (another profile, another view) drops what was being recorded and closes the microphone.
  const unmount = () => {
    gone.current = true;
    clear();
    const media = recorder.current;
    recorder.current = null;
    if (media) { media.onstop = null; media.ondataavailable = null; if (media.state !== 'inactive') media.stop(); }
    release();
  };
  // Stable, so React only runs it on mount and unmount (and twice in development's strict mode, hence the reset).
  const attach = useCallback((node: HTMLSpanElement | null) => { if (!node) return; gone.current = false; return unmount; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (handsFree = false) => {
    if (phase.current !== 'idle') return;
    dropped.current = false;
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Este equipo no permite grabar audio aquí.'); return; }
    move('starting');
    let input: MediaStream;
    try { input = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { move('idle'); setError('Sin permiso para el micrófono: dalo en los ajustes de privacidad del sistema y vuelve a intentarlo.'); return; }
    if (gone.current) { input.getTracks().forEach(track => track.stop()); return; }
    stream.current = input;
    const type = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    let media: MediaRecorder;
    try {
      media = new MediaRecorder(input, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: BITRATE });
      media.start();
    } catch { release(); move('idle'); setError('Este equipo no puede grabar audio aquí.'); return; }
    const chunks: Blob[] = [];
    media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    media.onstop = async () => {
      clear();
      release();
      recorder.current = null;
      const audio = new Blob(chunks, { type: media.mimeType || type || 'audio/webm' });
      if (!audio.size || dropped.current) { move('idle'); return; }
      if (audio.size > MAX_BYTES) { move('idle'); setError('La grabación es demasiado grande para dictar; prueba con menos tiempo.'); return; }
      move('transcribing');
      try {
        const heard = await transcribeVoice(audio);
        if (gone.current) return;
        if (heard.text) onText(heard.text); else setError('No se ha entendido nada; prueba a hablar más cerca.');
      } catch (failure) { if (!gone.current) setError(failure instanceof Error ? failure.message : 'No se pudo transcribir.'); }
      finally { move('idle'); }
    };
    recorder.current = media;
    move('recording'); setSeconds(0);
    if (handsFree) { play('step'); watchSilence(input); }  // a sound says «speak now» (when sounds are on)
    const tick = (n: number) => { timers.current.push(window.setTimeout(() => { setSeconds(n); if (n * 1000 < LIMIT_MS) tick(n + 1); }, 1000)); };
    tick(1);
    timers.current.push(window.setTimeout(() => { if (media.state === 'recording') media.stop(); }, LIMIT_MS));
  };
  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };
  const press = () => { if (state === 'recording') stop(); else if (state === 'idle') void start(); };
  // Watson's large microphone also answers ⌃⌥W and «Oye Watson»: each new request presses it.
  const requests = useListenRequests();
  const seen = useRef(requests);
  if (big && seen.current !== requests) {
    seen.current = requests;
    window.setTimeout(() => { if (phase.current === 'recording') stop(); else if (phase.current === 'idle' && !disabled) void start(true); }, 0);
  }
  const recording = state === 'recording';
  const modules = useModules();
  if (!moduleOn(modules, 'voz')) return null;
  return <span className="dictation" ref={attach}>
    <button type="button" className={`button dictation-button${recording ? ' recording' : ''}${big ? ' big' : ''}`} aria-label="Hablar y enviar"
      disabled={!recording && (disabled || state === 'starting')} aria-pressed={recording} aria-busy={state === 'transcribing'} onClick={press}
      title={recording ? 'Parar y enviar' : 'Hablar: pulsa, di tu mensaje y vuelve a pulsar para enviarlo (se transcribe en este equipo)'}>
      <Mic/>{recording ? <span aria-hidden="true">{seconds} s</span> : state === 'transcribing' ? <span aria-hidden="true">…</span> : null}
    </button>
    <span role="status" className="sr-only">{recording ? 'Grabando' : state === 'transcribing' ? 'Transcribiendo' : ''}</span>
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </span>;
}
