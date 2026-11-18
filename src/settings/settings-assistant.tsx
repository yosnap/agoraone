import { useEffect, useState, type FormEvent } from 'react';
import { refreshAssistantName } from '../assistant/assistant-name';
import {
  getAssistantSettings, getEngines, getPersonas, putAssistantSettings, putKey,
  type AssistantSettings, type Persona, type ToneKey,
} from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { Loading, LoadError } from '../ui/load-state';
import { engineLabels, modelLabels } from '../assistant/assistant-labels';
import { ActionButton } from '../ui/action-button';
import { keystoreName } from '../ui/platform';

const toneNames: Record<ToneKey, string> = { register: 'Registro', humor: 'Humor', length: 'Extensión', address: 'Tratamiento', language: 'Idioma' };
const toneValues: Record<string, string> = {
  cercano: 'Cercano', elegante: 'Elegante', culto: 'Culto', ninguno: 'Sin humor', ligero: 'Ligero', comico: 'Cómico',
  escueto: 'Escueto', detallado: 'Detallado', tu: 'De tú', usted: 'De usted', es: 'Español', en: 'Inglés', auto: 'El del usuario',
};

function KeyField({ kind, label }: { kind: 'anthropic' | 'compatible'; label: string }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = async (event: FormEvent, forget = false) => {
    event.preventDefault(); setNote(''); setError('');
    try { await putKey(kind, forget ? null : value.trim()); setValue(''); setNote(forget ? `Clave borrada del ${keystoreName}.` : `Clave guardada en el ${keystoreName}.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar la clave.'); }
  };
  return <form className="field-row" onSubmit={save}>
    <label className="field">{label}<input type="password" value={value} onChange={event => setValue(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Nunca se muestra una vez guardada"/></label>
    <div className="actions"><ActionButton icon="save" label="Guardar" tone="primary" type="submit" disabled={value.trim().length < 8}/><ActionButton icon="trash" label="Borrar" tone="danger" onClick={event => void save(event, true)}/></div>
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </form>;
}

/** Character, tone, model and engines of the assistant. Keys go to the Keychain and are never read back. */
export function AssistantSettingsCard() {
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [tones, setTones] = useState<Record<ToneKey, string[]> | null>(null);
  const [engines, setEngines] = useState<{ name: string; available: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [provider, setProvider] = useState({ baseUrl: '', model: '' });
  const refreshEngines = () => getEngines().then(data => setEngines(data.engines)).catch(() => setEngines([]));
  useEffect(() => {
    Promise.all([getAssistantSettings(), getPersonas()]).then(([current, list]) => {
      setSettings(current); setPersonas(list.personas); setTones(list.tone);
      setProvider({ baseUrl: current.compatible.baseUrl ?? '', model: current.compatible.model ?? '' });
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los ajustes.'));
    void refreshEngines();
  }, []);
  const change = async (changes: Partial<AssistantSettings>, what: string) => {
    setError(''); setSaved('');
    try { setSettings(await putAssistantSettings(changes)); setSaved(`${what} guardado.`); void refreshEngines(); if (changes.persona) refreshAssistantName(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  if (!settings || !tones) return <article className="card"><h2>Asistente</h2>{error ? <LoadError message={error}/> : <Loading label="Leyendo los ajustes del asistente"/>}</article>;
  return <article className="card settings-assistant" aria-labelledby="settings-assistant">
    <h2 id="settings-assistant">Asistente</h2>
    <fieldset className="persona-picker"><legend className="muted">Personaje</legend>
      {personas.map(persona => <label key={persona.id} className={`persona-option${settings.persona === persona.id ? ' chosen' : ''}`}>
        <input type="radio" name="persona" checked={settings.persona === persona.id} onChange={() => void change({ persona: persona.id }, 'Personaje')}/>
        <strong>{persona.name}</strong><small>{persona.conveys}</small><small className="muted">{persona.origin}</small>
      </label>)}
    </fieldset>
    <div className="tone-grid">{(Object.keys(toneNames) as ToneKey[]).map(key => <div key={key} className="field"><label htmlFor={`tone-${key}`}>{toneNames[key]}</label>
      <ModernSelect id={`tone-${key}`} value={settings.tone[key]} onChange={value => void change({ tone: { ...settings.tone, [key]: value } }, 'Tono')}
        options={tones[key].map(value => ({ value, label: toneValues[value] ?? value }))}/></div>)}</div>
    <small className="muted">El tono cambia la forma de hablar, nunca las cifras, los avisos ni las confirmaciones.</small>
    <div className="field-row">
      <div className="field"><span>Modelo de Claude</span><div className="segmented" role="group" aria-label="Modelo">{Object.entries(modelLabels).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={settings.model === id} onClick={() => void change({ model: id }, 'Modelo')}>{label}</button>)}</div></div>
      <div className="field"><label htmlFor="engine-choice">Motor</label><ModernSelect id="engine-choice" value={settings.engine ?? 'auto'}
        onChange={value => void change({ engine: value === 'auto' ? null : value }, 'Motor')}
        options={[{ value: 'auto', label: 'Automático (el primero disponible)' }, ...Object.entries(engineLabels).map(([value, label]) => ({ value, label }))]}/></div>
    </div>
    {engines && <ul className="engine-list" aria-label="Motores">{engines.map(engine => <li key={engine.name}>
      <span className={`chip ${engine.available ? 'good' : ''}`}>{engine.available ? 'Disponible' : 'No disponible'}</span> {engineLabels[engine.name] ?? engine.name}</li>)}</ul>}
    <small className="muted">Orden automático: tu sesión de Claude Code, luego la API de Anthropic y por último el proveedor compatible. AgoraOne no pide ni guarda credenciales de claude.ai.</small>
    <KeyField kind="anthropic" label="Clave de API de Anthropic"/>
    <form className="field-row" onSubmit={event => { event.preventDefault(); void change({ compatible: { baseUrl: provider.baseUrl.trim() || null, model: provider.model.trim() || null } }, 'Proveedor'); }}>
      <label className="field">Proveedor compatible (https, público)<input value={provider.baseUrl} onChange={event => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="https://…/v1" spellCheck={false}/></label>
      <label className="field">Modelo del proveedor<input value={provider.model} onChange={event => setProvider({ ...provider, model: event.target.value })} spellCheck={false}/></label>
      <div className="actions"><ActionButton icon="save" label="Guardar proveedor" tone="primary" type="submit"/></div>
    </form>
    <KeyField kind="compatible" label="Clave del proveedor compatible"/>
    <small className="muted">Al cambiar la dirección del proveedor, su clave se borra para no enviarla a otro sitio.</small>
    {saved && <span className="ok-note" role="status">{saved}</span>}{error && <LoadError message={error}/>}
  </article>;
}
