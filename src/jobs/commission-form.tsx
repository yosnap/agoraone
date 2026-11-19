import { useState } from 'react';
import { createCard } from '../api/client';
import { LoadError } from '../ui/load-state';
import { MarkdownField } from '../ui/markdown-field';
import { ModernSelect } from '../ui/modern-select';
import { ActionButton } from '../ui/action-button';

export type ProfileChoice = { id: string; name: string; label: string };

/** A commission («encargo»): a kanban card for one Hermes profile (the central bot unless another is chosen),
 * created with Hermes' own functions only on «Crear encargo». Hermes' dispatcher hands it to the profile. */
export function CommissionForm({ profiles, central, ready, onDone, onCancel }: {
  profiles: ProfileChoice[]; central: string; ready: { ok: boolean; why: string }; onDone: (note: string) => void; onCancel: () => void;
}) {
  // A central bot that no longer exists is not swapped silently for another profile: the user picks one.
  const centralExists = profiles.some(p => p.name === central);
  const [to, setTo] = useState(centralExists ? central : '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const profile = profiles.find(p => p.name === to);
  const send = async () => {
    if (!profile || !title.trim()) return;
    setBusy(true); setError('');
    try {
      await createCard(profile.id, { title: title.trim(), body: body.trim() || undefined });
      onDone(`Encargo «${title.trim()}» creado para ${profile.label}.${ready.ok ? '' : ` ${ready.why}`}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo crear el encargo.'); setBusy(false); }
  };
  return <form className="card task-form commission-form" aria-label="Nuevo encargo" onSubmit={event => { event.preventDefault(); void send(); }}>
    <label className="field">Para<ModernSelect value={to} onChange={setTo}
      options={[...(to === '' ? [{ value: '', label: 'Elige un perfil' }] : []), ...profiles.map(p => ({ value: p.name, label: p.name === central ? `${p.label} (bot central)` : p.label }))]}/></label>
    {!centralExists && <p className="fiscal-warning">El bot central de Ajustes («{central}») ya no existe en Hermes: elige a quién va el encargo o cámbialo en Ajustes › Trabajos.</p>}
    <label className="field">Qué quieres que haga<input autoFocus value={title} maxLength={200} required onChange={event => setTitle(event.target.value)}
      placeholder="Por ejemplo: revisa las facturas pendientes de Qonto"/></label>
    <div className="task-field"><span>Instrucciones (opcional)</span><MarkdownField label="Instrucciones (opcional)" value={body} onChange={setBody} minHeight={110} disabled={busy}/></div>
    <p className="approval-warning">El perfil trabajará en él por su cuenta, con sus herramientas y permisos y sin pedirte confirmación, como cualquier tarjeta del kanban de Hermes. Verás su estado, su tiempo y sus tokens aquí.</p>
    {!ready.ok && <p className="fiscal-warning">{ready.why}</p>}
    {error && <LoadError message={error}/>}
    <div className="field-row">
      <ActionButton icon="plus" label="Crear encargo" tone="primary" busyLabel={busy && 'Creando…'} type="submit" disabled={busy || !profile || !title.trim()}/>
      <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={onCancel}/>
    </div>
  </form>;
}
