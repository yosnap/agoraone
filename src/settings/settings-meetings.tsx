import { useRef, useState } from 'react';
import { getLocalModels, getMeetingSettings, getSummarizers, levelLabels, putMeetingSettings, type Level, type MeetingSettings, type Summarizer } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { hereLabel } from '../ui/platform';

/** The model on this machine that summarizes meetings marked «solo en este Mac» or private (LM Studio,
 * Ollama or any server with the OpenAI chat API on 127.0.0.1). Normal meetings are summarized by Claude. */
export function MeetingSettingsCard() {
  const [state, setState] = useState<MeetingSettings | null>(null);
  const [url, setUrl] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [who, setWho] = useState<Record<Level, Summarizer> | null>(null);
  const asked = useRef(false);
  const refreshWho = () => void getSummarizers().then(setWho).catch(() => setWho(null));
  if (!asked.current) {
    asked.current = true;
    refreshWho();
    // Start from the chosen server, else the one open now, and list its models straight away.
    void getMeetingSettings().then(next => {
      setState(next);
      const start = next.local_url ?? next.detected ?? next.known?.[0]?.url ?? '';
      setUrl(start);
      if (next.local_url || next.detected) void look(start);
    })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los ajustes.'));
  }
  async function look(address: string) {
    setError(''); setSaved(''); setModels(null);
    try { setModels((await getLocalModels(address)).models); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No responde.'); }
  }
  const save = async (changes: Partial<MeetingSettings>) => {
    setError(''); setSaved('');
    try { setState({ ...state, ...(await putMeetingSettings(changes)) }); setSaved('Guardado.'); refreshWho(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <article className="card" aria-labelledby="meeting-model-title">
    <div className="card-head"><h2 id="meeting-model-title">Resumen de reuniones</h2>
      {state && <span className={`status-badge ${state.local_model ? 'good' : 'paused'}`}>{state.local_model ? 'Modelo local elegido' : 'Sin modelo local'}</span>}</div>
    <p>Las reuniones normales las resume Claude. Las marcadas «solo en {hereLabel}» o privadas no salen del equipo: las resume un modelo que tengas aquí (LM Studio u Ollama con su servidor abierto) o, si no eliges ninguno, se quedan solo con la transcripción.</p>
    {who && <dl className="summarizers" aria-label="Quién resume cada reunión">
      <dt>Grabar y transcribir</dt><dd>Siempre en {hereLabel} (whisper). Nadie más oye el audio.</dd>
      <dt>Reuniones «{levelLabels.normal}»</dt><dd className={who.normal.by === 'claude' ? 'ok' : 'warn'}>{who.normal.label}</dd>
      <dt>«{levelLabels.local_only}» y «{levelLabels.private}»</dt><dd className={who.private.by === 'local' ? 'ok' : 'warn'}>{who.private.label}</dd>
    </dl>}
    {state && <label className="check"><input type="checkbox" checked={state.auto !== false} onChange={event => void save({ auto: event.target.checked })}/>
      Transcribir y resumir automáticamente al terminar cada grabación (en segundo plano y con prioridad baja)</label>}
    {!state && !error ? <Loading label="Leyendo los ajustes" lines={1}/> : state && <>
      <form className="field-row" onSubmit={event => { event.preventDefault(); void look(url.trim()); }}>
        <label className="field">Servidor local<input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://127.0.0.1:1234/v1" aria-describedby="meeting-model-hint"/></label>
        <button type="submit" className="button">Buscar modelos</button>
      </form>
      <div className="field-row" id="meeting-model-hint">{state.known?.map(k =>
        <button key={k.url} type="button" className="button" aria-pressed={url.trim() === k.url} onClick={() => { setUrl(k.url); void look(k.url); }}>
          {k.name}{state.detected === k.url ? ' · abierto' : ''}</button>)}</div>
      {models && (models.length
        ? <label className="field">Modelo<ModernSelect value={state.local_url === url.trim() ? state.local_model ?? '' : ''} onChange={value => void save({ local_url: url.trim(), local_model: value || null })}
            options={[{ value: '', label: 'Elige un modelo' }, ...models.map(m => ({ value: m, label: m }))]}/></label>
        : <p className="fiscal-warning">Ese servidor no tiene ningún modelo de chat que funcione en este equipo (los de la nube de Ollama y los de búsqueda no valen para resumir lo privado). Descarga uno, por ejemplo con <code>ollama pull qwen3:14b</code> (unos 9 GB) o desde LM Studio, y vuelve a buscar.</p>)}
      {state.local_model && <p className="muted">Se usa {state.local_model} en {state.local_url}. <button type="button" className="button" onClick={() => void save({ local_url: null, local_model: null })}>Quitar</button></p>}
    </>}
    {saved && <p className="ok-note" role="status">{saved}</p>}
    {error && <LoadError message={error}/>}
  </article>;
}
