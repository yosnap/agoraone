import { useRef, useState } from 'react';
import { transcribeVoice } from '../api/core';

const LIMIT_MS = 60_000;
// The first type the WebView can record: WebKit (macOS, Linux) records MP4/AAC, Chromium's WebView2 WebM/Opus.
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

/** Dictating instead of typing: press to record (up to a minute), press again to stop; the words, transcribed
 * on this machine by whisper.cpp, are added to the text box for the user to read, change and send. Nothing
 * is sent by itself. */
export function DictationButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach(t => window.clearTimeout(t)); timers.current = []; };
  const start = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Este equipo no permite grabar audio aquí.'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setError('Sin permiso para el micrófono: dalo en los ajustes de privacidad del sistema y vuelve a intentarlo.'); return; }
    const type = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    media.onstop = async () => {
      clear();
      stream.getTracks().forEach(track => track.stop());
      const audio = new Blob(chunks, { type: media.mimeType || type || 'audio/webm' });
      if (!audio.size) { setState('idle'); return; }
      setState('transcribing');
      try { const heard = await transcribeVoice(audio); if (heard.text) onText(heard.text); else setError('No se ha entendido nada; prueba a hablar más cerca.'); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo transcribir.'); }
      finally { setState('idle'); }
    };
    recorder.current = media;
    media.start();
    setState('recording'); setSeconds(0);
    const tick = (n: number) => { timers.current.push(window.setTimeout(() => { setSeconds(n); if (n * 1000 < LIMIT_MS) tick(n + 1); }, 1000)); };
    tick(1);
    timers.current.push(window.setTimeout(() => { if (media.state === 'recording') media.stop(); }, LIMIT_MS));
  };
  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };
  return <span className="dictation">
    <button type="button" className={`button dictation-button${state === 'recording' ? ' recording' : ''}`} disabled={disabled || state === 'transcribing'}
      aria-pressed={state === 'recording'} onClick={() => state === 'recording' ? stop() : void start()}
      title={state === 'recording' ? 'Parar y transcribir' : 'Dictar (la voz se transcribe en este equipo)'}>
      {state === 'recording' ? `● ${seconds} s · Parar` : state === 'transcribing' ? 'Transcribiendo…' : 'Dictar'}
    </button>
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </span>;
}
