import { useRef, useState } from 'react';
import { getTts, putTts, type TtsQuality, type TtsSettings, type TtsView } from '../api/core';
import { tryVoice } from '../assistant/speech';
import { lastProblem, refreshVoice } from '../assistant/voice-player';
import { ModernSelect } from '../ui/modern-select';
import { ActionButton } from '../ui/action-button';
import { hereLabel } from '../ui/platform';

const SAMPLE = 'Hola, soy Watson. Hoy tienes una reunión a las once y tres correos esperando.';
const spanishMacVoices = () => typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().filter(v => v.lang.startsWith('es'));

/** Which voice speaks Watson's answers (1.7): automatic (the «Watson (AgoraOne)» profile of VoiceStudio when it is
 * open, else macOS), a VoiceStudio voice, or a macOS voice; the speed; and «Probar». VoiceStudio runs on this Mac,
 * so nothing is sent outside it. */
export function WatsonVoiceChoice() {
  const [view, setView] = useState<TtsView | null>(null);
  const [mac, setMac] = useState<SpeechSynthesisVoice[]>(spanishMacVoices);
  const [speed, setSpeed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void getTts().then(setView).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer la voz.'));
    // macOS hands its voice list over a moment later.
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', () => setMac(spanishMacVoices()));
  }
  const save = async (changes: Partial<TtsSettings>) => {
    setError('');
    try { setView(await putTts(changes)); await refreshVoice(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  if (!view) return error ? <small className="dictation-error" role="alert">{error}</small> : null;
  const { settings, now, voicestudio } = view;
  const shownSpeed = speed ?? settings.speed;
  const studioVoices = (voicestudio ?? []).map(v => ({ value: v.id, label: `${v.name}${v.language ? ` · ${v.language}` : ''}` }));
  return <div className="card-fields">
    <label className="field">Voz de Watson<ModernSelect value={settings.engine} onChange={value => void save({ engine: value as TtsSettings['engine'] })} options={[
      { value: 'auto', label: 'Automática: «Watson (AgoraOne)» de VoiceStudio, o macOS' },
      { value: 'voicestudio', label: 'Una voz de VoiceStudio' },
      { value: 'macos', label: 'Una voz de macOS' }]}/></label>
    {settings.engine === 'voicestudio' && (voicestudio === null
      ? <small className="dictation-error">VoiceStudio no está abierto: ábrelo para elegir sus voces.</small>
      : <label className="field">Voz de VoiceStudio<ModernSelect value={settings.voice ?? ''} onChange={value => { if (value) void save({ voice: value }); }}
        options={[{ value: '', label: 'Elige una voz' }, ...studioVoices]}/></label>)}
    {(settings.engine === 'macos' || now.engine === 'macos') && mac.length > 0 && <label className="field">{settings.engine === 'macos' ? 'Voz de macOS' : 'Voz de macOS (si VoiceStudio no responde)'}
      <ModernSelect value={settings.macVoice ?? ''} onChange={value => void save({ macVoice: value || null })}
        options={[{ value: '', label: 'La primera en español de España' }, ...mac.filter((v, i, all) => all.findIndex(o => o.name === v.name) === i).map(v => ({ value: v.name, label: `${v.name} · ${v.lang}` }))]}/></label>}
    <label className="field">Velocidad · {shownSpeed.toLocaleString('es-ES', { maximumFractionDigits: 2 })}×
      <input type="range" min={0.7} max={1.5} step={0.05} value={shownSpeed} onChange={event => setSpeed(Number(event.target.value))}
        onPointerUp={() => speed !== null && void save({ speed })} onKeyUp={() => speed !== null && void save({ speed })} onBlur={() => speed !== null && speed !== settings.speed && void save({ speed })}/></label>
    {settings.engine !== 'macos' && <label className="field">Rapidez de VoiceStudio<ModernSelect value={settings.quality} onChange={value => void save({ quality: value as TtsQuality })} options={[
      { value: 'fast', label: 'Rápida: empieza antes y gasta menos, algo menos natural' },
      { value: 'balanced', label: 'Equilibrada (recomendada)' },
      { value: 'best', label: 'Más natural: tarda el doble en empezar' }]}/></label>}
    {settings.engine !== 'macos' && view.installed && <label className="check"><input type="checkbox" checked={settings.openAtStart}
      onChange={event => void save({ openAtStart: event.target.checked })}/> Abrir VoiceStudio en segundo plano al arrancar AgoraOne</label>}
    <div className="inbox-actions"><ActionButton icon="play" label="Probar" onClick={() => tryVoice(SAMPLE)}/></div>
    <small className="muted" role="status">Ahora habla {now.engine === 'voicestudio' ? `VoiceStudio${voicestudio?.find(v => v.id === now.voice) ? ` con «${voicestudio.find(v => v.id === now.voice)!.name}»` : ''}, en ${hereLabel}` : 'macOS'}.
      {now.engine === 'voicestudio' && ' La primera frase tarda uno o dos segundos en sonar; el resto se prepara mientras habla.'}</small>
    {(now.problem || lastProblem) && <small className="dictation-error" role="status">{now.problem || lastProblem}</small>}
    {error && <small className="dictation-error" role="alert">{error}</small>}
  </div>;
}
