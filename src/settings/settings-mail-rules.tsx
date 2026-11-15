import { useRef, useState, type FormEvent } from 'react';
import {
  changeMailRule, createMailRule, deleteMailRule, getMailAccounts, getMailRules, getScopes, levelLabels,
  type Level, type MailAccount, type MailRule, type MailRuleAction, type Scope,
} from '../api/core';
import { actionLabels } from '../inbox/inbox-labels';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

const actions = (Object.keys(actionLabels) as MailRuleAction[]).map(value => ({ value, label: actionLabels[value] }));
const levels = [{ value: '', label: 'El de la cuenta' }, ...(['local_only', 'private'] as Level[]).map(value => ({ value, label: levelLabels[value] }))];
const empty = { name: '', sender: '', accountId: '', subject: '', words: '', action: 'invoice' as MailRuleAction, scopeId: '', confidentiality: '' };

/** The user's rules for incoming mail: they decide before the automatic classification, oldest first. */
export function MailRulesCard() {
  const [rules, setRules] = useState<MailRule[] | null>(null);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [form, setForm] = useState(empty);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    Promise.all([getMailRules(), getMailAccounts(), getScopes()]).then(([found, list, known]) => { setRules(found.rules); setAccounts(list.accounts); setScopes(known.scopes); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las reglas.'));
  }
  const act = async (work: () => Promise<{ rules: MailRule[] }>, done: string) => {
    setError(''); setNote('');
    try { setRules((await work()).rules); setNote(done); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); return false; }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    const text = (value: string) => value.trim() || null;
    void act(() => createMailRule({
      name: form.name.trim(), sender: text(form.sender), accountId: form.accountId ? Number(form.accountId) : null, subject: text(form.subject),
      words: text(form.words), action: form.action, scopeId: form.scopeId ? Number(form.scopeId) : null,
      confidentiality: (form.confidentiality || null) as Level | null, enabled: true,
    }), 'Regla creada; ya se aplica a lo pendiente de la Bandeja.').then(ok => { if (ok) { setForm(empty); setAdding(false); } });
  };
  const accountOptions = [{ value: '', label: 'Todas las cuentas' }, ...accounts.map(a => ({ value: String(a.id), label: a.address }))];
  const scopeOptions = [{ value: '', label: 'El de la cuenta' }, ...scopes.map(s => ({ value: String(s.id), label: s.name }))];
  const describe = (rule: MailRule) => [
    rule.sender && `de ${rule.sender}`, rule.accountId && `en ${accounts.find(a => a.id === rule.accountId)?.address ?? 'una cuenta'}`,
    rule.subject && `asunto con «${rule.subject}»`, rule.words && `palabras: ${rule.words}`,
  ].filter(Boolean).join(' · ');
  return <article className="card" aria-labelledby="mail-rules-title">
    <div className="card-head"><h2 id="mail-rules-title">Reglas del correo</h2>
      {!adding && <button type="button" className="button" onClick={() => setAdding(true)}>Añadir regla</button>}</div>
    <p>Mandan sobre la clasificación automática: la primera que coincide decide. Un dominio (cliente.com) incluye sus subdominios. El nivel de una regla solo puede ser más estricto que el de la cuenta.</p>
    {rules === null && !error ? <Loading label="Leyendo las reglas"/> : <ul className="mail-accounts">
      {rules?.length === 0 && <li className="muted">Aún no hay reglas. También puedes crearlas desde una tarjeta de la Bandeja.</li>}
      {rules?.map(rule => <li key={rule.id}>
        <div className="mail-account-head"><strong>{rule.name}</strong>
          <span className={`chip ${rule.enabled ? 'good' : ''}`}>{actionLabels[rule.action]}{rule.enabled ? '' : ' · desactivada'}</span></div>
        <span className="muted">{describe(rule)}{rule.scopeId ? ` → ${scopes.find(s => s.id === rule.scopeId)?.name ?? 'ámbito'}` : ''}{rule.confidentiality ? ` · ${levelLabels[rule.confidentiality]}` : ''}</span>
        <div className="field-row">
          <button type="button" className="button" onClick={() => void act(() => changeMailRule(rule.id, { enabled: !rule.enabled }), rule.enabled ? 'Regla desactivada.' : 'Regla activada.')}>{rule.enabled ? 'Desactivar' : 'Activar'}</button>
          {removing === rule.id ? <span className="field-row" role="group" aria-label={`Confirmar quitar ${rule.name}`}>
            <button type="button" className="button danger" onClick={() => void act(() => deleteMailRule(rule.id), 'Regla quitada.').then(() => setRemoving(null))}>Quitar de verdad</button>
            <button type="button" className="button" onClick={() => setRemoving(null)}>Cancelar</button></span>
            : <button type="button" className="button danger" onClick={() => setRemoving(rule.id)}>Quitar…</button>}
        </div>
      </li>)}
    </ul>}
    {adding && <form className="mail-new" onSubmit={add}>
      <label className="field">Nombre<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Facturas de PayPal"/></label>
      <label className="field">Qué es<ModernSelect value={form.action} options={actions} onChange={value => setForm({ ...form, action: value as MailRuleAction })}/></label>
      <div className="mail-account-fields">
        <label className="field">Remitente o dominio<input value={form.sender} onChange={event => setForm({ ...form, sender: event.target.value })} placeholder="paypal.com" autoComplete="off"/></label>
        <label className="field">Cuenta<ModernSelect value={form.accountId} options={accountOptions} onChange={value => setForm({ ...form, accountId: value })}/></label>
        <label className="field">Asunto contiene<input maxLength={200} value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })}/></label>
        <label className="field">Palabras (separadas por comas)<input maxLength={200} value={form.words} onChange={event => setForm({ ...form, words: event.target.value })} placeholder="factura, invoice"/></label>
        <label className="field">Ámbito<ModernSelect value={form.scopeId} options={scopeOptions} onChange={value => setForm({ ...form, scopeId: value })}/></label>
        <label className="field">Nivel<ModernSelect value={form.confidentiality} options={levels} onChange={value => setForm({ ...form, confidentiality: value })}/></label>
      </div>
      <div className="field-row"><button className="button primary">Guardar regla</button>
        <button type="button" className="button" onClick={() => { setAdding(false); setForm(empty); }}>Cancelar</button></div>
    </form>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
