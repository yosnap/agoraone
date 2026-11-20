import { useRef, useState } from 'react';
import { getVoiceStatus, getWake, putVoiceSettings, putWake, type VoiceSettings, type VoiceStatus, type Wake } from '../api/core';
import { wakeStatus } from './wake-status';
import { WatsonVoiceChoice } from './watson-voice-choice';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { listenShortcut } from '../ui/platform';
import { setVoiceMode, voiceMode, type VoiceMode } from '../assistant/speech';
import { ActionButton } from '../ui/action-button';

const OTHER = '__otra__';
const languages = [{ value: 'auto', label: 'Detectar el idioma' }, { value: 'es', label: 'Español' }, { value: 'en', label: 'Inglés' },
  { value: 'ca', label: 'Catalán' }, { value: 'pt', label: 'Portugués' }, { value: 'fr', label: 'Francés' }, { value: 'it', label: 'Italiano' }, { value: 'de', label: 'Alemán' }];
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1e6)} MB`;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** One program or model: the ones found, or a path typed by hand (Linux and Windows install them elsewhere). */
function PathChoice({ label, value, found, onSave, describe }: {
  label: string; value: string | null; found: { path: string; text: string }[]; onSave: (path: string | null) => void; describe: string;
}) {
  const known = !value || found.some(f => f.path === value);
  const [typing, setTyping] = useState(!known);
  const [text, setText] = useState(known ? '' : value ?? '');
  return <div className="voice-choice">
    <label className="field">{label}<ModernSelect value={typing ? OTHER : value ?? ''} onChange={next => {
      if (next === OTHER) { setTyping(true); return; }
      setTyping(false); onSave(next || null);
    }} options={[{ value: '', label: found.length ? `Automático (${found[0].text})` : 'Automático (no se ha encontrado)' }, ...found.map(f => ({ value: f.path, label: f.text })), { value: OTHER, label: 'Otra ruta…' }]}/></label>
    {typing && <form className="field-row" onSubmit={event => { event.preventDefault(); onSave(text.trim() || null); }}>
      <input value={text} onChange={event => setText(event.target.value)} placeholder={describe} aria-label={`Ruta de ${label.toLowerCase()}`}/>
      <ActionButton icon="save" label="Guardar" type="submit"/>
    </form>}
  </div>;
}

/** Speech to text on this machine (whisper.cpp + ffmpeg), for dictating in the chats and for meetings. */
export function VoiceSettingsCard() {
  const [state, setState] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const asked = useRef(false);
  const load = () => getVoiceStatus().then(setState).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer la voz.'));
  if (!asked.current) { asked.current = true; void load(); }
  const save = async (changes: Partial<VoiceSettings>) => {
    setError(''); setSaved('');
    try { await putVoiceSettings(changes); setSaved('Guardado.'); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const windows = state?.platform === 'win32';
  return <article className="card wide" aria-labelledby="voice-title">
    <div className="card-head"><h2 id="voice-title">Voz</h2>
      {state && <span className={`status-badge ${state.ready ? 'good' : 'paused'}`}>{state.ready ? 'Lista' : 'Falta algo'}</span>}</div>
    <p>La voz se transcribe en este equipo con <strong>whisper.cpp</strong>, para dictar en los chats y para las reuniones. El audio no sale de aquí. Necesita el programa <code>whisper-cli</code>, <code>ffmpeg</code> y un modelo de Whisper (<code>ggml-….bin</code>); AgoraOne los busca donde suele instalarlos cada sistema y aquí puedes elegir otros.</p>
    {!state && !error ? <Loading label="Buscando whisper.cpp y sus modelos" lines={2}/> : state && <>
      <div className="card-fields">
      <PathChoice label="Programa de Whisper" value={state.chosen.binary} describe={windows ? 'C:\\…\\whisper-cli.exe' : '/ruta/a/whisper-cli'}
        found={state.binaries.map(path => ({ path, text: path }))} onSave={path => void save({ binary: path })}/>
      <PathChoice label="ffmpeg" value={state.chosen.ffmpeg} describe={windows ? 'C:\\…\\ffmpeg.exe' : '/ruta/a/ffmpeg'}
        found={state.ffmpegs.map(path => ({ path, text: path }))} onSave={path => void save({ ffmpeg: path })}/>
      <PathChoice label="Modelo" value={state.chosen.model} describe={windows ? 'C:\\…\\ggml-large-v3-turbo.bin' : '/ruta/a/ggml-large-v3-turbo.bin'}
        found={state.models.map(m => ({ path: m.path, text: `${m.name} · ${size(m.bytes)} · ${fileName(m.path)}` }))} onSave={path => void save({ model: path })}/>
      <label className="field">Idioma<ModernSelect value={state.chosen.language} options={languages} onChange={value => void save({ language: value })}/></label>
      <WatsonVoice/>
      </div>
      <WatsonVoiceChoice/>
      <WakeWord platform={state.platform}/>
      {!state.ready && <p className="fiscal-warning">{state.missing.length ? `Lo elegido ya no está (${state.missing.map(k => k === 'binary' ? 'whisper-cli' : k === 'model' ? 'el modelo' : 'ffmpeg').join(', ')}): ¿se desinstaló o actualizó? Elígelo de nuevo.`
        : !state.binary ? 'No se encuentra whisper-cli: instala whisper.cpp (Homebrew, el gestor de paquetes de tu Linux o la versión para Windows) o indica dónde está.'
        : !state.ffmpeg ? 'No se encuentra ffmpeg: instálalo o indica dónde está.'
        : 'Falta un modelo: descarga uno de whisper.cpp (por ejemplo ggml-large-v3-turbo.bin) e indica dónde está.'}</p>}
      {state.ready && <p className="muted">Se usa {fileName(state.binary ?? '')} con el modelo {fileName(state.model ?? '')}.</p>}
    </>}
    {saved && <p className="ok-note" role="status">{saved}</p>}
    {error && <LoadError message={error}/>}
  </article>;
}

/** Whether Watson answers aloud, with the system's own voices (per viewer). */
function WatsonVoice() {
  const [mode, setMode] = useState<VoiceMode>(voiceMode);
  return <label className="field">Watson responde hablando<ModernSelect value={mode} onChange={value => { setVoiceMode(value as VoiceMode); setMode(value as VoiceMode); }}
    options={[{ value: 'spoken', label: 'Cuando le hablas con el micrófono' }, { value: 'always', label: 'Siempre' }, { value: 'never', label: 'Nunca' }]}/></label>;
}

/** «Oye Watson» from any app, heard on this Mac (Apple's on-device recognition): off unless turned on here. Under
 * the box, what the desktop app's listener is doing: listening, or why it could not start and how to fix it. */
function WakeWord({ platform }: { platform: string }) {
  // Heard with macOS' on-device recognition: elsewhere the box says so and stays off.
  const supported = platform === 'darwin';
  const [wake, setWake] = useState<Wake | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const round = useRef(0);
  // The listener takes a few seconds to start (and macOS may be asking for permission): look again for up to a
  // minute. Only the latest round of looks counts, so answers from an older click never overwrite newer ones.
  const follow = (left: number, mine = ++round.current) => void getWake().then(state => {
    if (mine !== round.current) return;
    setWake(state);
    if (left > 0 && state.enabled && (state.state === null || state.state === 'starting' || state.state === 'off')) setTimeout(() => follow(left - 1, mine), 2000);
  }).catch(() => setWake(current => current ?? { enabled: false, state: null, attempt: 0 }));
  if (!asked.current) { asked.current = true; follow(3); }
  const change = async (next: boolean) => {
    setError('');
    const mine = ++round.current;
    try {
      const saved = await putWake(next);
      if (mine === round.current) setWake(saved);
      if (next) setTimeout(() => follow(30, mine), 1500);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const status = wake?.enabled ? wakeStatus(wake.state) : null;
  return <div className="field">
    <label className="check"><input type="checkbox" checked={supported && wake?.enabled === true} disabled={!supported || wake === null} onChange={event => void change(event.target.checked)}/> Escuchar «Oye Watson»</label>
    <small className="muted">{supported
      ? 'Di «Oye Watson» desde cualquier app y Watson empieza a escuchar, como con ⌃⌥W. Se reconoce en este Mac (sin internet) y no se guarda ni se envía nada de lo que oye. Mientras esté activo, el micrófono queda abierto y macOS enseña su punto naranja. Solo en la app de escritorio del Mac; la primera vez macOS pide los permisos de micrófono y reconocimiento de voz.'
      : `«Oye Watson» todavía no está disponible en este sistema; en la app de escritorio puedes llamar a Watson desde cualquier ventana con ${listenShortcut}.`}</small>
    {supported && status && <small className={status.ok ? 'ok-note' : 'dictation-error'} role="status">{status.text}</small>}
    {supported && status && !status.ok && status.retry && <div className="inbox-actions">
      <ActionButton icon="refresh" label="Reintentar" onClick={() => void change(true)}/>
    </div>}
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </div>;
}
