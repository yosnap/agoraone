import { useEffect, useState, type FormEvent } from 'react';
import {
  changeMailAccount, createMailAccount, createScope, deleteMailAccount, getMailAccounts, getMailPresets, getScopes, levelLabels, syncMailAccount,
  type Level, type MailAccount, type MailPreset, type MailProvider, type Scope,
} from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { MicrosoftClientField, MicrosoftConnect } from './settings-microsoft';
import { ProviderLogo } from './provider-logos';
import { Loading, LoadError } from '../ui/load-state';
import { hereLabel, keystoreName } from '../ui/platform';

const statusLabels: Record<MailAccount['status'], string> = {
  pending: 'Pendiente de leer', ok: 'Conectada', auth: 'Revisa la contraseña', unreachable: 'Sin conexión', error: 'Error del servidor',
};
const levels = (['normal', 'local_only', 'private'] as const).map(level => ({ value: level, label: levelLabels[level] }));
const empty = { address: '', provider: 'gmail' as MailProvider, username: '', imapHost: '', imapPort: 993, smtpHost: '', password: '', scopeId: '', confidentiality: 'normal' as Level, maxAgeDays: 60 };
const syncNotes: Record<string, string> = {
  busy: 'Ya se estaba leyendo esta cuenta; espera un momento.', auth: 'El servidor no aceptó la contraseña: revisa el aviso de la cuenta.',
  unreachable: 'No se pudo conectar con el servidor.', error: 'El servidor respondió con un error: revisa el aviso de la cuenta.',
};

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
}

/** Scope picker with «new scope…» inline. */
function ScopeSelect({ value, scopes, onChange, onCreated, id }: { value: string; scopes: Scope[]; onChange: (v: string) => void; onCreated: (s: Scope[]) => void; id?: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [failed, setFailed] = useState('');
  const create = async () => {
    setFailed('');
    try {
      const { scopes: list } = await createScope(name.trim()); onCreated(list);
      const made = list.filter(scope => scope.name === name.trim()).sort((a, b) => b.id - a.id)[0];
      if (made) onChange(String(made.id)); setNaming(false); setName('');
    } catch (failure) { setFailed(failure instanceof Error ? failure.message : 'No se pudo crear el ámbito.'); }
  };
  if (naming) return <span className="field-row">
    <input aria-label="Nombre del ámbito nuevo" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="CodeIA, Humanitek…"/>
    <button type="button" className="button primary" disabled={!name.trim()} onClick={() => void create()}>Crear</button>
    <button type="button" className="button" onClick={() => setNaming(false)}>Cancelar</button>{failed && <LoadError message={failed}/>}</span>;
  return <ModernSelect id={id} value={value} onChange={choice => choice === 'new' ? setNaming(true) : onChange(choice)}
    options={[{ value: '', label: 'Sin ámbito' }, ...scopes.map(scope => ({ value: String(scope.id), label: scope.name })), { value: 'new', label: 'Nuevo ámbito…' }]}/>;
}

/** The mail accounts AgoraOne reads (read-only IMAP), each with its scope and confidentiality. Passwords go to the Keychain. */
export function MailSettingsCard() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [presets, setPresets] = useState<Record<MailProvider, MailPreset> | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [form, setForm] = useState(empty);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [removing, setRemoving] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof Error ? failure.message : fallback);
  const load = () => {
    setError('');
    Promise.all([getMailAccounts(), getMailPresets(), getScopes()]).then(([list, known, found]) => { setAccounts(list.accounts); setPresets(known.presets); setScopes(found.scopes); })
      .catch(failure => fail(failure, 'No se pudieron leer las cuentas.'));
  };
  useEffect(load, []);
  /** Runs a change; true only when it worked, so forms are cleared only then. */
  const act = async (id: number | 'new', work: () => Promise<{ accounts: MailAccount[] }>, done: string) => {
    setBusy(id); setError(''); setNote('');
    try { setAccounts((await work()).accounts); if (done) setNote(done); return true; }
    catch (failure) { fail(failure, 'No se pudo completar.'); return false; } finally { setBusy(null); }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    const other = form.provider === 'other';
    void act('new', () => createMailAccount({
      address: form.address.trim(), provider: form.provider, username: form.username.trim() || undefined,
      imapHost: other ? form.imapHost.trim() : undefined, imapPort: other ? form.imapPort : undefined, smtpHost: other && form.smtpHost.trim() ? form.smtpHost.trim() : undefined,
      scopeId: form.scopeId ? Number(form.scopeId) : null, confidentiality: form.confidentiality, maxAgeDays: form.maxAgeDays, password: form.password || undefined,
    }), `${form.provider === 'microsoft' ? 'Cuenta añadida: pulsa «Conectar con Microsoft».' : `Cuenta añadida. La contraseña está en el ${keystoreName}; pulsa «Leer ahora» para probarla.`}`).then(ok => { if (ok) { setForm(empty); setAdding(false); } });
  };
  if (!accounts || !presets) return <article className="card"><h2>Cuentas de correo</h2>{error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo las cuentas de correo"/>}</article>;
  const preset = presets[form.provider];
  return <article className="card settings-mail" aria-labelledby="settings-mail">
    <h2 id="settings-mail">Cuentas de correo</h2>
    <p>AgoraOne lee la bandeja de entrada en <strong>solo lectura</strong>: no marca nada como leído, no mueve ni borra. Cada cuenta lleva su ámbito y su nivel: lo «solo en {hereLabel}» no va a modelos externos y lo privado no sale del núcleo.</p>
    {accounts.length ? <ul className="mail-accounts compact">{accounts.map(account => <li key={account.id} className={open.has(account.id) ? 'open' : ''}>
      <div className="compact-row">
        <button type="button" className="compact-toggle" aria-expanded={open.has(account.id)} onClick={() => toggle(account.id)}
          title={open.has(account.id) ? 'Cerrar' : 'Ver y editar'}>
          <ProviderLogo provider={account.provider}/>
          <span className="compact-name"><strong>{account.address}</strong>
            <small className="muted">{account.scopeName ?? 'Sin ámbito'}{account.confidentiality !== 'normal' ? ` · ${levelLabels[account.confidentiality]}` : ''} · {account.messages} correos · {when(account.lastSyncAt)}</small></span>
          <span className={`status-badge ${!account.enabled ? 'paused' : account.status === 'ok' ? 'good' : account.status === 'pending' ? 'waiting' : 'bad'}`}>
            {account.enabled ? statusLabels[account.status] : 'En pausa'}</span>
          <span className="compact-chevron" aria-hidden="true">▾</span>
        </button>
        <button className="button compact-action" disabled={busy === account.id || !account.hasPassword} title="Leer ahora"
          onClick={() => void act(account.id, async () => {
            const answer = await syncMailAccount(account.id);
            setNote(answer.result.status === 'ok' ? `Leídos ${answer.result.added} correos nuevos${answer.result.added ? ' (el resto llega en segundo plano)' : ''}.` : syncNotes[answer.result.status] ?? 'No se pudo leer.');
            return answer;
          }, '')}>{busy === account.id ? 'Leyendo…' : 'Leer'}</button>
      </div>
      {account.lastError && account.status !== 'ok' && <small className="mail-error">{account.lastError}</small>}
      {open.has(account.id) && <>
      <div className="mail-account-fields">
        <label className="field">Ámbito<ScopeSelect value={account.scopeId ? String(account.scopeId) : ''} scopes={scopes} onCreated={setScopes}
          onChange={value => void act(account.id, () => changeMailAccount(account.id, { scopeId: value ? Number(value) : null }), 'Ámbito guardado.')}/></label>
        <label className="field">Nivel<ModernSelect value={account.confidentiality} options={levels}
          onChange={value => void act(account.id, () => changeMailAccount(account.id, { confidentiality: value as Level }), 'Nivel guardado.')}/></label>
      </div>
      {account.auth === 'microsoft' ? <MicrosoftConnect accountId={account.id} connected={account.hasPassword} onDone={load}/> :
      <form className="field-row" onSubmit={event => { event.preventDefault(); void act(account.id, () => changeMailAccount(account.id, { password: passwords[account.id] }), `Contraseña guardada en el ${keystoreName}.`).then(ok => { if (ok) setPasswords({ ...passwords, [account.id]: '' }); }); }}>
        <label className="field">{account.hasPassword ? 'Cambiar la contraseña de aplicación' : 'Contraseña de aplicación'}
          <input type="password" autoComplete="off" spellCheck={false} value={passwords[account.id] ?? ''} onChange={event => setPasswords({ ...passwords, [account.id]: event.target.value })} placeholder="Nunca se muestra una vez guardada"/></label>
        <button className="button" disabled={(passwords[account.id] ?? '').length < 4 || busy === account.id}>Guardar</button>
      </form>}
      <div className="actions">
        <button className="button" disabled={busy === account.id} onClick={() => void act(account.id, () => changeMailAccount(account.id, { enabled: !account.enabled }), account.enabled ? 'Cuenta en pausa.' : 'Cuenta reanudada.')}>{account.enabled ? 'Pausar' : 'Reanudar'}</button>
        {removing === account.id ? <span className="field-row" role="group" aria-label={`Confirmar quitar ${account.address}`}>
          <small>Se borran sus correos guardados y su contraseña del {keystoreName}; el buzón no se toca.</small>
          <button className="button danger" disabled={busy === account.id} onClick={() => void act(account.id, () => deleteMailAccount(account.id), 'Cuenta quitada.').then(() => setRemoving(null))}>Quitar</button>
          <button className="button" onClick={() => setRemoving(null)}>Cancelar</button>
        </span> : <button className="button danger" disabled={busy === account.id} onClick={() => setRemoving(account.id)}>Quitar…</button>}
      </div>
      </>}
    </li>)}</ul> : <p className="muted">Todavía no hay cuentas conectadas.</p>}
    {adding ? <form className="mail-new" onSubmit={add} aria-label="Nueva cuenta de correo">
      <label className="field">Proveedor<ModernSelect value={form.provider} onChange={value => setForm({ ...form, provider: value as MailProvider })}
        options={(Object.keys(presets) as MailProvider[]).map(key => ({ value: key, label: presets[key].name }))}/></label>
      <small className="muted">{preset.hint}</small>
      {form.provider === 'microsoft' && <MicrosoftClientField/>}
      <label className="field">Dirección<input type="email" required value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} autoComplete="off"/></label>
      {form.provider !== 'microsoft' && <label className="field">Usuario (si no es la dirección)<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoComplete="off"/></label>}
      {form.provider === 'other' && <div className="mail-account-fields">
        <label className="field">Servidor IMAP<input required value={form.imapHost} onChange={event => setForm({ ...form, imapHost: event.target.value })} placeholder="imap.tudominio.com"/></label>
        <label className="field">Puerto IMAP (SSL)<input type="number" min={1} max={65535} value={form.imapPort} onChange={event => setForm({ ...form, imapPort: Math.max(1, Math.min(65535, Number(event.target.value) || 993)) })}/></label>
        <label className="field">Servidor SMTP<input value={form.smtpHost} onChange={event => setForm({ ...form, smtpHost: event.target.value })} placeholder="smtp.tudominio.com"/></label>
      </div>}
      {form.provider !== 'microsoft' && <label className="field">Contraseña de aplicación<input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="off" spellCheck={false} placeholder={`Va directa al ${keystoreName}`}/></label>}
      <div className="mail-account-fields">
        <label className="field">Ámbito<ScopeSelect value={form.scopeId} scopes={scopes} onCreated={setScopes} onChange={value => setForm({ ...form, scopeId: value })}/></label>
        <label className="field">Nivel<ModernSelect value={form.confidentiality} options={levels} onChange={value => setForm({ ...form, confidentiality: value as Level })}/></label>
        <label className="field">Días hacia atrás<input type="number" min={1} max={3650} value={form.maxAgeDays} onChange={event => setForm({ ...form, maxAgeDays: Math.max(1, Math.min(3650, Number(event.target.value) || 60)) })}/></label>
      </div>
      <div className="actions"><button className="button primary" disabled={busy === 'new' || !form.address.includes('@')}>Añadir cuenta</button><button type="button" className="button" onClick={() => setAdding(false)}>Cancelar</button></div>
    </form> : <div className="actions"><button className="button" onClick={() => setAdding(true)}>Añadir cuenta</button></div>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
