import { useRef, useState } from 'react';
import { getMicrosoftClient, getMicrosoftSignIn, putMicrosoftClient, startMicrosoftSignIn, type MicrosoftSignIn } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ActionButton } from '../ui/action-button';

/** The user's own Microsoft app registration (its id is public, not a secret), with the steps to create it. */
export function MicrosoftClientField() {
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; getMicrosoftClient().then(data => setClientId(data.clientId)).catch(() => setClientId(null)); }
  const save = async (value: string | null) => {
    setError(''); setNote('');
    try { setClientId((await putMicrosoftClient(value)).clientId); setDraft(''); setEditing(false); setNote(value ? 'Identificador guardado.' : 'Identificador borrado.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <div className="mail-microsoft">
    <strong>Aplicación de Microsoft</strong>
    {clientId && !editing ? <p className="muted">Registrada: <code>{clientId}</code> <button type="button" className="button" onClick={() => setEditing(true)}>Cambiar…</button></p> : <>
      {clientId && <p className="muted">Si cambias el identificador, tendrás que volver a conectar todas las cuentas de Microsoft. <ActionButton icon="close" label="Cancelar" onClick={() => { setEditing(false); setDraft(''); }}/></p>}
      <p className="muted">Microsoft solo deja leer el correo a aplicaciones registradas. Se hace una vez y es gratis:</p>
      <ol className="mail-steps">
        <li>Entra en <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Microsoft Entra › Registros de aplicaciones</a> con tu cuenta de Microsoft y pulsa «Nuevo registro».</li>
        <li>Nombre: AgoraOne. Tipos de cuenta: «cuentas de cualquier directorio organizativo y cuentas personales de Microsoft». Sin URI de redirección.</li>
        <li>En «Autenticación», activa «Permitir flujos de clientes públicos».</li>
        <li>En «Permisos de API», añade de Office 365 Exchange Online (o Microsoft Graph) los permisos delegados <code>IMAP.AccessAsUser.All</code>, <code>SMTP.Send</code> y <code>offline_access</code>.</li>
        <li>Copia el «Id. de aplicación (cliente)» y pégalo aquí.</li>
      </ol>
      <form className="field-row" onSubmit={event => { event.preventDefault(); void save(draft.trim()); }}>
        <label className="field">Id. de aplicación (cliente)<input value={draft} onChange={event => setDraft(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false} autoComplete="off"/></label>
        <ActionButton icon="save" label="Guardar" tone="primary" type="submit" disabled={draft.trim().length < 36}/>
      </form>
    </>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </div>;
}

/** «Conectar con Microsoft»: shows the code to type at Microsoft's page and waits for the user to accept. */
export function MicrosoftConnect({ accountId, connected, onDone }: { accountId: number; connected: boolean; onDone: () => void }) {
  const [signIn, setSignIn] = useState<MicrosoftSignIn | null>(null);
  const [error, setError] = useState('');
  // Polling stops when the card leaves the screen, when the code expires or after a few failed reads.
  const live = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const asked = useRef(false);
  // A stable callback ref (a new function each render would detach and stop the polling on every render).
  const holder = useRef((node: HTMLDivElement | null) => {
    live.current = node !== null;
    if (!node) window.clearTimeout(timer.current);
  }).current;
  const follow = (failures = 0) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!live.current) return;
      getMicrosoftSignIn(accountId).then(state => {
        if (!live.current) return;
        setSignIn(state);
        if (state.state === 'waiting' && Date.now() / 1000 < (state.expiresAt ?? 0)) follow(); else if (state.state === 'done') onDone();
      }).catch(() => { if (failures < 4) follow(failures + 1); else setError('No se pudo comprobar la conexión con Microsoft.'); });
    }, 3000);
  };
  // A sign-in already in progress (the page was reloaded meanwhile) shows its code again.
  if (!asked.current) {
    asked.current = true;
    getMicrosoftSignIn(accountId).then(state => { if (live.current && state.state === 'waiting') { setSignIn(state); follow(); } }).catch(() => undefined);
  }
  const start = async () => {
    setError('');
    try { const state = await startMicrosoftSignIn(accountId); setSignIn(state); follow(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo empezar.'); }
  };
  const waiting = signIn?.state === 'waiting';
  return <div className="mail-microsoft-connect" ref={holder}>
    {waiting ? <p role="status">Abre <a href={signIn.verificationUri} target="_blank" rel="noreferrer">{signIn.verificationUri}</a>, escribe el código <strong className="mail-code">{signIn.userCode}</strong> y acepta los permisos. Esta pantalla se actualiza sola.</p>
      : <button type="button" className="button primary" onClick={() => void start()}>{connected ? 'Volver a conectar con Microsoft' : 'Conectar con Microsoft'}</button>}
    {signIn?.state === 'done' && <span className="ok-note" role="status">Cuenta conectada. Pulsa «Leer ahora».</span>}
    {signIn && ['declined', 'expired', 'error', 'cancelled'].includes(signIn.state) && <LoadError message={signIn.message ?? 'No se completó la conexión.'}/>}
    {error && <LoadError message={error}/>}
  </div>;
}
