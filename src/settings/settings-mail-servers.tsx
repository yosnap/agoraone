import { useState } from 'react';
import { changeMailAccount, type MailAccount } from '../api/core';

const port = (text: string, fallback: number) => Math.max(1, Math.min(65535, Number(text) || fallback));

/** Editing an account's username and servers (not for Microsoft, which signs in by itself): the reading server
 * for a mailbox, the sending one for every account. Saving leaves the account pending until it is read or tried. */
export function MailServersForm({ account, busy, onSave }: {
  account: MailAccount; busy: boolean; onSave: (work: () => ReturnType<typeof changeMailAccount>, done: string) => Promise<boolean>;
}) {
  const start = { username: account.username, imapHost: account.imapHost, imapPort: String(account.imapPort), smtpHost: account.smtpHost ?? '', smtpPort: String(account.smtpPort ?? 465) };
  const [form, setForm] = useState(start);
  const mailbox = account.kind === 'mailbox';
  const changed = (Object.keys(start) as (keyof typeof start)[]).some(key => form[key] !== start[key]);
  const save = () => void onSave(() => changeMailAccount(account.id, {
    username: form.username.trim(),
    ...(mailbox ? { imapHost: form.imapHost.trim(), imapPort: port(form.imapPort, 993) } : {}),
    // An empty sending server on a mailbox removes it (it can no longer send); a sending-only account needs one.
    smtpHost: form.smtpHost.trim() || (mailbox ? null : undefined), smtpPort: form.smtpHost.trim() ? port(form.smtpPort, 465) : undefined,
  }), 'Usuario y servidores guardados.');
  return <details className="mail-servers">
    <summary>Usuario y servidores</summary>
    <div className="mail-account-fields">
      <label className="field">Usuario<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoComplete="off" spellCheck={false}/></label>
      {mailbox && <>
        <label className="field">Servidor IMAP<input value={form.imapHost} onChange={event => setForm({ ...form, imapHost: event.target.value })}/></label>
        <label className="field">Puerto IMAP<input type="number" min={1} max={65535} value={form.imapPort} onChange={event => setForm({ ...form, imapPort: event.target.value })}/></label>
      </>}
      <label className="field">Servidor SMTP<input value={form.smtpHost} onChange={event => setForm({ ...form, smtpHost: event.target.value })} placeholder={mailbox ? 'Para enviar (opcional)' : ''}/></label>
      <label className="field">Puerto SMTP<input type="number" min={1} max={65535} value={form.smtpPort} onChange={event => setForm({ ...form, smtpPort: event.target.value })}/></label>
      <div className="actions mail-servers-actions">
      <button type="button" className="button" disabled={!changed || busy || !form.username.trim() || (mailbox ? !form.imapHost.trim() : !form.smtpHost.trim())} onClick={save}>Guardar</button>
      {changed && <button type="button" className="button" onClick={() => setForm(start)}>Deshacer</button>}
      </div>
    </div>
  </details>;
}
