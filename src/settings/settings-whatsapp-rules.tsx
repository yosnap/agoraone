import { useRef, useState, type FormEvent } from 'react';
import {
  changeChatRule, createChatRule, deleteChatRule, getChatRules, getChatSettings, getScopes, levelLabels,
  type ChatAccount, type ChatRule, type Level, type MailRuleAction, type Scope,
} from '../api/core';
import { actionLabels } from '../inbox/inbox-labels';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { chatRuleForm, chatRuleFromForm, describeChatRule, emptyChatRuleForm, type ChatRuleForm } from './whatsapp-rules';

const actions = (Object.keys(actionLabels) as MailRuleAction[]).map(value => ({ value, label: actionLabels[value] }));
const levels = [{ value: '', label: 'El de la cuenta' }, ...(['local_only', 'private'] as Level[]).map(value => ({ value, label: levelLabels[value] }))];

/** The user's rules for WhatsApp conversations: they decide before the automatic classification, oldest first, and
 * a label (for example «Instinct» on its number) shows where a conversation comes from. */
export function WhatsAppRulesCard() {
  const [rules, setRules] = useState<ChatRule[] | null>(null);
  const [accounts, setAccounts] = useState<ChatAccount[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [form, setForm] = useState<ChatRuleForm>(emptyChatRuleForm);
  // null: no form open; 'new': creating; a number: editing that rule.
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  const load = () => {
    setError('');
    Promise.all([getChatRules(), getChatSettings(), getScopes()]).then(([found, settings, known]) => {
      setRules(found.rules); setAccounts(settings.accounts); setScopes(known.scopes);
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las reglas de WhatsApp.'));
  };
  if (!asked.current) { asked.current = true; load(); }
  const act = async (work: () => Promise<{ rules: ChatRule[] }>, done: string) => {
    setBusy(true); setError(''); setNote('');
    try { setRules((await work()).rules); setNote(done); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); return false; }
    finally { setBusy(false); }
  };
  const close = () => { setEditing(null); setForm(emptyChatRuleForm); };
  const open = (rule: ChatRule | null) => { setEditing(rule ? rule.id : 'new'); setForm(rule ? chatRuleForm(rule) : emptyChatRuleForm); setNote(''); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    const current = typeof editing === 'number' ? rules?.find(rule => rule.id === editing) : undefined;
    const rule = chatRuleFromForm(form, current?.enabled ?? true);
    void act(() => (typeof editing === 'number' ? changeChatRule(editing, rule) : createChatRule(rule)),
      typeof editing === 'number' ? 'Regla guardada; ya se aplica a las conversaciones.' : 'Regla creada; ya se aplica a las conversaciones.')
      .then(ok => { if (ok) close(); });
  };
  const accountName = (id: number) => { const found = accounts.find(a => a.id === id); return found?.phone ?? found?.label ?? 'una cuenta'; };
  const accountOptions = [{ value: '', label: 'Todas las cuentas' }, ...accounts.map(a => ({ value: String(a.id), label: a.phone ?? a.label ?? `Cuenta ${a.id}` }))];
  const scopeOptions = [{ value: '', label: 'El de la cuenta' }, ...scopes.map(s => ({ value: String(s.id), label: s.name }))];
  return <article className="card" aria-labelledby="whatsapp-rules-title">
    <div className="card-head"><h2 id="whatsapp-rules-title">Reglas de WhatsApp</h2>
      {editing === null && <button type="button" className="button" onClick={() => open(null)}>Añadir regla</button>}</div>
    <p>Mandan sobre la clasificación automática de las conversaciones: la primera que coincide decide. El contacto es un número (con o sin prefijo) o el identificador del participante; las palabras se buscan en toda la conversación, también en lo que escribes tú. La etiqueta se muestra como origen de la conversación. El nivel de una regla solo puede ser más estricto que el de la cuenta.</p>
    {rules === null && !error ? <Loading label="Leyendo las reglas"/> : <ul className="mail-accounts">
      {rules?.length === 0 && <li className="muted">Aún no hay reglas.</li>}
      {rules?.map(rule => <li key={rule.id}>
        <div className="mail-account-head"><strong>{rule.name}</strong>
          <span className={`chip ${rule.enabled ? 'good' : ''}`}>{rule.label ? `${rule.label} · ` : ''}{actionLabels[rule.action]}{rule.enabled ? '' : ' · desactivada'}</span></div>
        <span className="muted">{describeChatRule(rule, accountName)}{rule.scopeId ? ` → ${scopes.find(s => s.id === rule.scopeId)?.name ?? 'ámbito'}` : ''}{rule.confidentiality ? ` · ${levelLabels[rule.confidentiality]}` : ''}</span>
        <div className="field-row">
          <button type="button" className="button" disabled={busy || editing !== null} onClick={() => open(rule)}>Editar</button>
          <button type="button" className="button" disabled={busy} onClick={() => void act(() => changeChatRule(rule.id, { enabled: !rule.enabled }), rule.enabled ? 'Regla desactivada.' : 'Regla activada.')}>{rule.enabled ? 'Desactivar' : 'Activar'}</button>
          {removing === rule.id ? <span className="field-row" role="group" aria-label={`Confirmar quitar ${rule.name}`}>
            <button type="button" className="button danger" disabled={busy} onClick={() => void act(() => deleteChatRule(rule.id), 'Regla quitada.').then(() => setRemoving(null))}>Quitar de verdad</button>
            <button type="button" className="button" onClick={() => setRemoving(null)}>Cancelar</button></span>
            : <button type="button" className="button danger" disabled={busy} onClick={() => setRemoving(rule.id)}>Quitar…</button>}
        </div>
      </li>)}
    </ul>}
    {editing !== null && <form className="mail-new" onSubmit={save} aria-label={editing === 'new' ? 'Nueva regla de WhatsApp' : 'Editar regla de WhatsApp'}>
      <label className="field">Nombre<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Avisos de Instinct"/></label>
      <label className="field">Qué es<ModernSelect value={form.action} options={actions} onChange={value => setForm({ ...form, action: value as MailRuleAction })}/></label>
      <div className="mail-account-fields">
        <label className="field">Contacto<input maxLength={100} value={form.contact} onChange={event => setForm({ ...form, contact: event.target.value })} placeholder="+34 600 000 000" autoComplete="off"/></label>
        <label className="field">Cuenta<ModernSelect value={form.accountId} options={accountOptions} onChange={value => setForm({ ...form, accountId: value })}/></label>
        <label className="field">Palabras (separadas por comas)<input maxLength={200} value={form.words} onChange={event => setForm({ ...form, words: event.target.value })} placeholder="factura, presupuesto"/></label>
        <label className="field">Etiqueta<input maxLength={40} value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} placeholder="Instinct"/></label>
        <label className="field">Ámbito<ModernSelect value={form.scopeId} options={scopeOptions} onChange={value => setForm({ ...form, scopeId: value })}/></label>
        <label className="field">Nivel<ModernSelect value={form.confidentiality} options={levels} onChange={value => setForm({ ...form, confidentiality: value })}/></label>
      </div>
      <div className="field-row"><button className="button primary" disabled={busy}>{editing === 'new' ? 'Guardar regla' : 'Guardar cambios'}</button>
        <button type="button" className="button" onClick={close}>Cancelar</button></div>
    </form>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error} onRetry={rules === null ? load : undefined}/>}
  </article>;
}
