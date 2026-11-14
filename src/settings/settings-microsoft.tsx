import { useRef, useState } from 'react';
import { getMicrosoftClient, getMicrosoftSignIn, putMicrosoftClient, startMicrosoftSignIn, type MicrosoftSignIn } from '../api/core';
import { LoadError } from '../ui/load-state';

/** The user's own Microsoft app registration (its id is public, not a secret), with the steps to create it. */
export function MicrosoftClientField() {
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; getMicrosoftClient().then(data => setClientId(data.clientId)).catch(() => setClientId(null)); }
  const save = async (value: string | null) => {
    setError(''); setNote('');
    try { setClientId((await putMicrosoftClient(value)).clientId); setDraft(''); setNote(value ? 'Identificador guardado.' : 'Identificador borrado.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <div className="mail-microsoft">
    <strong>Aplicación de Microsoft</strong>
    {clientId ? <p className="muted">Registrada: <code>{clientId}</code> <button type="button" className="button" onClick={() => void save(null)}>Cambiar</button></p> : <>
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
        <button className="button primary" disabled={draft.trim().length < 36}>Guardar</button>
      </form>
    </>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </div>;
}

/** «Conectar con Microsoft»: shows the code to type at Microsoft's page and waits for the user to accept. */
export function MicrosoftConnect({ accountId, connected, onDone }: { accountId: number; connected: boolean; onDone: () => void }) {
  const [signIn, setSignIn] = useState<MicrosoftSignIn | null>(null);
  const [error, setError] = useState('');
  const follow = () => {
    window.setTimeout(() => {
      getMicrosoftSignIn(accountId).then(state => {
        setSignIn(state);
        if (state.state === 'waiting') follow(); else if (state.state === 'done') onDone();
      }).catch(() => follow());
    }, 3000);
  };
  const start = async () => {
    setError('');
    try { const state = await startMicrosoftSignIn(accountId); setSignIn(state); follow(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo empezar.'); }
  };
  const waiting = signIn?.state === 'waiting';
  return <div className="mail-microsoft-connect">
    {waiting ? <p role="status">Abre <a href={signIn.verificationUri} target="_blank" rel="noreferrer">{signIn.verificationUri}</a>, escribe el código <strong className="mail-code">{signIn.userCode}</strong> y acepta los permisos. Esta pantalla se actualiza sola.</p>
      : <button type="button" className="button primary" onClick={() => void start()}>{connected ? 'Volver a conectar con Microsoft' : 'Conectar con Microsoft'}</button>}
    {signIn?.state === 'done' && <span className="ok-note" role="status">Cuenta conectada. Pulsa «Leer ahora».</span>}
    {signIn && ['declined', 'expired', 'error'].includes(signIn.state) && <LoadError message={signIn.message ?? 'No se completó la conexión.'}/>}
    {error && <LoadError message={error}/>}
  </div>;
}
