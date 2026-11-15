import { useRef, useState } from 'react';
import { getLocalModels, getMeetingSettings, putMeetingSettings, type MeetingSettings } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

/** The model on this machine that summarizes meetings marked «solo en este Mac» or private (LM Studio,
 * Ollama or any server with the OpenAI chat API on 127.0.0.1). Normal meetings are summarized by Claude. */
export function MeetingSettingsCard() {
  const [state, setState] = useState<MeetingSettings | null>(null);
  const [url, setUrl] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void getMeetingSettings().then(next => { setState(next); setUrl(next.local_url ?? next.known?.[0]?.url ?? ''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los ajustes.'));
  }
  const look = async (address: string) => {
    setError(''); setSaved(''); setModels(null);
    try { setModels((await getLocalModels(address)).models); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No responde.'); }
  };
  const save = async (changes: Partial<MeetingSettings>) => {
    setError(''); setSaved('');
    try { setState({ ...state, ...(await putMeetingSettings(changes)) }); setSaved('Guardado.'); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <article className="card" aria-labelledby="meeting-model-title">
    <div className="card-head"><h2 id="meeting-model-title">Resumen de reuniones</h2>
      {state && <span className={`status-badge ${state.local_model ? 'good' : 'paused'}`}>{state.local_model ? 'Modelo local elegido' : 'Sin modelo local'}</span>}</div>
    <p>Las reuniones normales las resume Claude. Las marcadas «solo en este Mac» o privadas no salen del equipo: las resume un modelo que tengas aquí (LM Studio u Ollama con su servidor abierto) o, si no eliges ninguno, se quedan solo con la transcripción.</p>
    {!state && !error ? <Loading label="Leyendo los ajustes" lines={1}/> : state && <>
      <form className="field-row" onSubmit={event => { event.preventDefault(); void look(url.trim()); }}>
        <label className="field">Servidor local<input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://127.0.0.1:1234/v1" aria-describedby="meeting-model-hint"/></label>
        <button type="submit" className="button">Buscar modelos</button>
      </form>
      <small id="meeting-model-hint" className="muted">{state.known?.map(k => `${k.name}: ${k.url}`).join(' · ')}</small>
      {models && (models.length
        ? <label className="field">Modelo<ModernSelect value={state.local_url === url.trim() ? state.local_model ?? '' : ''} onChange={value => void save({ local_url: url.trim(), local_model: value || null })}
            options={[{ value: '', label: 'Elige un modelo' }, ...models.map(m => ({ value: m, label: m }))]}/></label>
        : <p className="muted">Ese servidor no tiene ningún modelo cargado.</p>)}
      {state.local_model && <p className="muted">Se usa {state.local_model} en {state.local_url}. <button type="button" className="button" onClick={() => void save({ local_url: null, local_model: null })}>Quitar</button></p>}
    </>}
    {saved && <p className="ok-note" role="status">{saved}</p>}
    {error && <LoadError message={error}/>}
  </article>;
}
