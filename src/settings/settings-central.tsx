import { useRef, useState, type FormEvent } from 'react';
import { checkCentralWindow, deleteCentralConnection, getCentralConnection, putCentralConnection, scopeLabels, testCentralConnection,
  type CentralConnection, type CentralScope, type CentralStatus } from '../api/central';
import { Loading, LoadError } from '../ui/load-state';

const scopes: CentralScope[] = ['lectura', 'presupuestos', 'escritura'];
const scopeMeaning: Record<CentralScope, string> = {
  lectura: 'clientes, proyectos, webs, servidores y agenda', presupuestos: 'ver y crear presupuestos en borrador', escritura: 'reservado para más adelante',
};

export const centralMoved = 'Ahora Central se conecta con su dirección y una clave de acceso: créala en Ajustes › Apps conectadas de Central.';

function badge(state: CentralConnection): [string, string] {
  if (state.transport === 'http') return ['good', 'Dirección y clave guardadas'];
  if (state.legacy) return ['waiting', 'Hay que volver a conectarlo'];
  return ['paused', 'Sin conectar'];
}

/** Settings › Central: the URL of Central (on a server or on this computer) and an access key created in Central's
 * Settings › Apps conectadas. The key goes to the system's secret store and is never shown again. Available with the
 * Central and Presupuestos modules off, so a connection can always be made or undone. */
export function CentralSettingsCard() {
  const [state, setState] = useState<CentralConnection | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<CentralStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  const show = (found: CentralConnection) => { setState(found); setUrl(found.url ?? found.suggestedUrl); };
  const load = () => {
    setError('');
    getCentralConnection().then(show).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer la conexión con Central.'));
  };
  if (!asked.current) { asked.current = true; load(); }
  const run = async (name: string, work: () => Promise<string>) => {
    setBusy(name); setError(''); setNote('');
    try { setNote(await work()); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); return false; }
    finally { setBusy(null); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run('save', async () => {
      const next = await putCentralConnection(url.trim(), key.trim() || undefined);
      show(next); setKey('');
      void checkCentralWindow().catch(() => undefined);  // another address closes Central's window
      return key.trim() ? 'Conexión guardada; la clave está en el almacén de secretos del sistema.' : 'Dirección guardada.';
    });
  };
  const test = () => void run('test', async () => {
    const found = await testCentralConnection(url.trim() || undefined, key.trim() || undefined);
    setStatus(found);
    return `Central ${found.version ?? ''} responde${found.runtime === 'local' ? ' (en este equipo)' : ''}.`;
  });
  const forget = () => void run('forget', async () => {
    setForgetting(false); setStatus(null);
    show(await deleteCentralConnection());
    return 'Clave borrada del almacén de secretos. AgoraOne ya no lee Central por su API.';
  });
  if (!state) return <article className="card"><h2>Central</h2>{error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo la conexión con Central"/>}</article>;
  const [tone, label] = badge(state);
  const canTest = (state.hasKey || key.trim().length > 0) && url.trim().length > 0;
  return <article className="card settings-mail" aria-labelledby="central-settings-title">
    <div className="card-head"><h2 id="central-settings-title">Central</h2><span className={`status-badge ${tone}`}>{label}</span></div>
    <p>Central sigue siendo una aplicación aparte. AgoraOne se conecta a ella con su dirección y una clave de acceso que creas en <strong>Ajustes › Apps conectadas</strong> de Central; la clave se guarda solo en el almacén de secretos del sistema y no se vuelve a mostrar. Sin Central no se ven sus clientes ni sus presupuestos.</p>
    {state.legacy && <p className="notice" role="status">{centralMoved}</p>}
    {state.storeProblem && <p className="fiscal-warning" role="alert">{state.storeProblem}</p>}
    <form className="field-row" onSubmit={save}>
      <label className="field">Dirección de Central
        <input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} placeholder={state.suggestedUrl}/></label>
      <label className="field">{state.hasKey ? 'Cambiar la clave (déjala vacía para conservarla)' : 'Clave de acceso'}
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder={state.hasKey ? 'Hay una clave guardada' : 'cen_…'}/></label>
      <span className="actions">
        <button type="button" className="button" disabled={!canTest || busy !== null} onClick={test}>{busy === 'test' ? 'Probando…' : 'Probar'}</button>
        <button className="button primary" disabled={!url.trim() || (!state.hasKey && !key.trim()) || busy !== null}>{busy === 'save' ? 'Guardando…' : 'Guardar'}</button>
      </span>
    </form>
    <small className="muted">Fuera de este equipo solo se admite https. Para una Central en este ordenador vale http://localhost:3099.</small>
    {status && <div>
      <p><strong>Central {status.version ?? 'sin versión'}</strong>{status.runtime ? ` · ${status.runtime === 'local' ? 'en este equipo' : 'en un servidor'}` : ''}. Lo que permite la clave:</p>
      <ul className="install-list">{scopes.map(scope => <li key={scope} className="install-row">
        <span><span className={`status-badge ${status.scopes.includes(scope) ? 'good' : 'paused'}`}>{status.scopes.includes(scope) ? 'Sí' : 'No'}</span> {scopeLabels[scope]}</span>
        <small className="muted">{scopeMeaning[scope]}</small>
      </li>)}</ul>
    </div>}
    {state.hasKey && <div className="actions">
      {forgetting ? <span className="field-row" role="group" aria-label="Confirmar desconectar Central">
        <small>Se borra la clave del almacén de secretos; los datos ya leídos se conservan.</small>
        <button type="button" className="button danger" disabled={busy !== null} onClick={forget}>Desconectar de verdad</button>
        <button type="button" className="button" onClick={() => setForgetting(false)}>Cancelar</button></span>
        : <button type="button" className="button danger" disabled={busy !== null} onClick={() => setForgetting(true)}>Desconectar…</button>}
    </div>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
