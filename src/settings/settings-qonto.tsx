import { useRef, useState } from 'react';
import { checkQonto, getQonto, putQonto } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ActionButton } from '../ui/action-button';

/** Qonto, read-only: the organisation's login and secret key (the key goes to the Keychain and is never shown). */
export function QontoSettingsCard() {
  const [state, setState] = useState<{ login: string | null; hasKey: boolean } | null>(null);
  const [login, setLogin] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [forgetting, setForgetting] = useState(false);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getQonto().then(found => { setState(found); setLogin(found.login ?? ''); })
      .catch(failure => { setState({ login: null, hasKey: false }); setError(failure instanceof Error ? failure.message : 'No se pudo leer el ajuste de Qonto.'); });
  }
  const run = async (work: () => Promise<string>) => { setError(''); setNote(''); try { setNote(await work()); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); } };
  return <article className="card" aria-labelledby="qonto-title">
    <div className="card-head"><h2 id="qonto-title">Qonto</h2>
      {state && <span className={`status-badge ${state.login && state.hasKey ? 'good' : 'paused'}`}>{state.login && state.hasKey ? 'Configurado' : 'Sin conectar'}</span>}</div>
    <p>Solo lectura: AgoraOne lee tus facturas emitidas para el Excel trimestral y nunca emite, cambia ni paga nada. La clave está en Qonto › Ajustes › Integraciones › Clave de API.</p>
    <form className="mail-account-fields" onSubmit={event => { event.preventDefault(); void run(async () => {
      const saved = await putQonto({ login: login.trim() || null, ...(secret ? { secret } : {}) }); setState(saved); setSecret(''); return 'Guardado. La clave está en el Llavero.'; }); }}>
      <label className="field">Identificador (login)<input value={login} onChange={event => setLogin(event.target.value)} autoComplete="off" spellCheck={false}/></label>
      <label className="field">{state?.hasKey ? 'Cambiar la clave secreta' : 'Clave secreta'}<input type="password" value={secret} onChange={event => setSecret(event.target.value)}
        autoComplete="off" spellCheck={false} placeholder="Va directa al Llavero"/></label>
      <div className="field-row"><ActionButton icon="save" label="Guardar" tone="primary" type="submit" disabled={!login.trim() && !state?.login}/>
        <ActionButton icon="play" label="Probar" disabled={!state?.hasKey} onClick={() => void run(async () => { const found = await checkQonto(); return `Conectado con ${found.name ?? 'tu organización'} (${found.accounts} cuentas).`; })}/>
        {state?.hasKey && (forgetting ? <span className="field-row" role="group" aria-label="Confirmar borrar la clave">
          <ActionButton icon="trash" label="Borrar de verdad" tone="danger" onClick={() => void run(async () => { setForgetting(false); setState(await putQonto({ secret: null })); return 'Clave borrada del Llavero.'; })}/>
          <ActionButton icon="close" label="Cancelar" onClick={() => setForgetting(false)}/></span>
          : <ActionButton icon="trash" label="Borrar la clave…" tone="danger" onClick={() => setForgetting(true)}/>)}</div>
    </form>
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
