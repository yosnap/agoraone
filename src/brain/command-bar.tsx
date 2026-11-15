import { useState } from 'react';
import { DictationButton } from '../ui/dictation-button';
import { toggleQuickRecording, useMeetingRecorder } from '../meetings/meeting-recorder';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The brain's command bar, the one place to act from (user's decision, 15/11/2026): ask Watson by typing
 * or speaking (the words go straight to Watson's panel beside it), record a meeting, and, from 1.5, music.
 * Nothing here runs a model by itself: a question is sent only with Enter or the microphone. */
export function CommandBar({ onAsk }: { onAsk: (text: string) => void }) {
  const [text, setText] = useState('');
  const recorder = useMeetingRecorder();
  const recording = recorder.phase === 'recording';
  const send = (spoken?: string) => {
    const question = (spoken === undefined ? text : (text.trim() ? `${text.trimEnd()} ${spoken}` : spoken)).trim();
    if (!question) return;
    onAsk(question);
    setText('');
  };
  return <div className="command-bar" role="search" aria-label="Centro de mando">
    <form className="command-ask" onSubmit={event => { event.preventDefault(); send(); }}>
      <label htmlFor="command-input" className="visually-hidden">Pregunta o pide algo a Watson</label>
      <input id="command-input" value={text} onChange={event => setText(event.target.value)} autoComplete="off" maxLength={4000}
        placeholder="Pregunta a tu cerebro o pídele algo a Watson… o pulsa el micrófono"/>
      <DictationButton onText={spoken => send(spoken)}/>
    </form>
    <button type="button" className={`button command-record${recording ? ' on' : ''}`} onClick={toggleQuickRecording}
      disabled={recorder.phase === 'starting' || recorder.phase === 'stopping'} aria-pressed={recording}
      title={recording ? 'Parar la grabación de la reunión' : 'Grabar una reunión ahora, con las opciones de la última vez'}>
      <span className="command-dot" aria-hidden="true"/>
      {recording ? `Parar · ${clock(recorder.seconds)}` : recorder.phase === 'stopping' ? 'Cerrando…' : recorder.phase === 'starting' ? 'Empezando…' : 'Grabar reunión'}
    </button>
    <button type="button" className="button command-music" disabled title="La música llega en la versión 1.5: Apple Music, Spotify, tu biblioteca y YouTube">
      ♫ Música <small>(1.5)</small>
    </button>
  </div>;
}
