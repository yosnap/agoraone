import { useRef, useState, type FormEvent } from 'react';
import { getJevSettings, putJevKey, putJevSettings, testJev, type JevPoint, type JevSettings } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { shadowLine } from './jev-shadow';
import { Loading, LoadError } from '../ui/load-state';
import { ActionButton } from '../ui/action-button';

const PINNED = 'pinned';
const modelOptions = [
  { value: 'jev-latest', label: 'jev-latest (la versión estable más reciente)' },
  { value: 'jev-preview', label: 'jev-preview (la que viene)' },
  { value: PINNED, label: 'Versión fijada' },
];
const points: JevPoint[] = ['mail', 'chat', 'deadlines', 'tasks', 'meetings', 'fiscal', 'watson'];
const tokens = new Intl.NumberFormat('es-ES');
const dollars = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

type Form = { choice: string; pinned: string; monthlyUsd: string; threshold: string };
const formOf = (found: JevSettings): Form => ({
  choice: found.aliases.includes(found.model) ? found.model : PINNED, pinned: found.aliases.includes(found.model) ? 'jev-1.14.0' : found.model,
  monthlyUsd: String(found.monthlyUsd), threshold: String(found.threshold),
});

/** Settings › Jev (TypeSafe): the key goes to the Keychain and is never shown again; the model, the monthly cap,
 * the confidence from which Jev decides and a switch per decision point, with this month's use. Only what is of
 * normal level ever goes to Jev, and it never replaces a confirmation of the user. */
export function JevSettingsCard() {
  const [state, setState] = useState<JevSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  const show = (found: JevSettings) => { setState(found); setForm(formOf(found)); };
  const load = () => {
    setError('');
    getJevSettings().then(show).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer el ajuste de Jev.'));
  };
  if (!asked.current) { asked.current = true; load(); }
  /** Runs one action; `work` returns the new settings (or null) and the note to show. */
  const run = async (name: string, work: () => Promise<[JevSettings | null, string]>) => {
    setBusy(name); setError(''); setNote('');
    try { const [next, said] = await work(); if (next) show(next); setNote(said); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); return false; }
    finally { setBusy(null); }
  };
  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    void run('key', async () => [await putJevKey(key.trim()), 'Clave guardada en el Llavero. Pulsa «Probar» para comprobarla.']).then(ok => { if (ok) setKey(''); });
  };
  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const model = form.choice === PINNED ? form.pinned.trim() : form.choice;
    const monthlyUsd = Number(form.monthlyUsd.replace(',', '.'));
    const threshold = Number(form.threshold.replace(',', '.'));
    if (!/^jev-\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(model) && form.choice === PINNED) { setError('Escribe la versión como jev-1.14.0.'); return; }
    if (!(monthlyUsd > 0 && monthlyUsd <= 100)) { setError('El tope mensual va de más de 0 a 100 $.'); return; }
    if (!(threshold >= 0.5 && threshold <= 1)) { setError('La confianza mínima va de 0,5 a 1.'); return; }
    void run('settings', async () => [await putJevSettings({ model, monthlyUsd, threshold }), 'Ajuste de Jev guardado.']);
  };
  const togglePoint = (point: JevPoint, value: boolean) =>
    void run(`point-${point}`, async () => [await putJevSettings({ points: { [point]: value } }), value ? 'Punto encendido.' : 'Punto apagado: ahí sigue la lógica de siempre.']);
  if (!state || !form) return <article className="card"><h2>Jev</h2>{error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo el ajuste de Jev"/>}</article>;
  const used = state.usage;
  const share = used.capTokens ? Math.min(100, Math.round((used.inputTokens / used.capTokens) * 100)) : 0;
  return <article className="card settings-mail" aria-labelledby="jev-title">
    <div className="card-head"><h2 id="jev-title">Jev (TypeSafe)</h2>
      <span className={`status-badge ${state.hasKey ? 'good' : 'paused'}`}>{state.hasKey ? 'Clave guardada' : 'Sin clave'}</span></div>
    <p>Jev es un modelo que <strong>decide, no escribe</strong>: responde a preguntas tipadas (qué clase tiene un correo, con qué prisa, a qué proyecto va) con su confianza. Claude sigue escribiendo resúmenes, actas y borradores. Solo recibe lo de nivel normal, nunca lo «solo en este Mac» ni lo privado, y nunca sustituye una confirmación tuya. TypeSafe lo aloja en EE. UU. y no entrena con lo que recibe.</p>
    <p className="muted">En sombra: el correo y WhatsApp ya le preguntan, pero su respuesta solo se guarda para compararla con lo de hoy (reglas, Haiku o palabras locales); no cambia nada de lo que ves. Los demás puntos, pendientes.</p>
    <p><strong>{shadowLine(state.shadow)}.</strong></p>
    <form className="field-row" onSubmit={saveKey}>
      <label className="field">{state.hasKey ? 'Cambiar la clave de API de TypeSafe' : 'Clave de API de TypeSafe'}
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="Va directa al Llavero"/></label>
      <ActionButton icon="save" label="Guardar" tone="primary" type="submit" disabled={key.trim().length < 8 || busy !== null}/>
    </form>
    <div className="actions">
      <button type="button" className="button" disabled={!state.hasKey || busy !== null} onClick={() => void run('test', async () => {
        const found = await testJev();
        return [null, found.models.length ? `Clave válida. Modelos de tu cuenta: ${found.models.join(', ')}.` : 'Clave válida, pero la cuenta no lista ningún modelo.'];
      })}>{busy === 'test' ? 'Probando…' : 'Probar'}</button>
      {state.hasKey && (forgetting ? <span className="field-row" role="group" aria-label="Confirmar borrar la clave">
        <small>Jev deja de recibir preguntas; todo sigue con la lógica de siempre.</small>
        <ActionButton icon="trash" label="Borrar de verdad" tone="danger" disabled={busy !== null} onClick={() => void run('key', async () => { setForgetting(false); return [await putJevKey(null), 'Clave borrada del Llavero.']; })}/>
        <ActionButton icon="close" label="Cancelar" onClick={() => setForgetting(false)}/></span>
        : <ActionButton icon="trash" label="Borrar la clave…" tone="danger" disabled={busy !== null} onClick={() => setForgetting(true)}/>)}
    </div>
    <form className="field-row" onSubmit={saveSettings}>
      <label className="field">Modelo<ModernSelect value={form.choice} options={modelOptions} disabled={busy !== null} onChange={choice => setForm({ ...form, choice })}/></label>
      {form.choice === PINNED && <label className="field">Versión<input value={form.pinned} spellCheck={false} onChange={event => setForm({ ...form, pinned: event.target.value })} placeholder="jev-1.14.0"/></label>}
      <label className="field">Tope al mes ($)<input inputMode="decimal" value={form.monthlyUsd} onChange={event => setForm({ ...form, monthlyUsd: event.target.value })}/></label>
      <label className="field">Confianza para decidir<input inputMode="decimal" value={form.threshold} onChange={event => setForm({ ...form, threshold: event.target.value })}/></label>
      <ActionButton icon="save" label="Guardar" tone="primary" type="submit" disabled={busy !== null}/>
    </form>
    <small className="muted">Con la confianza mínima o más, Jev decide; por debajo, solo sugiere y decides tú. Al llegar al tope, Jev se para hasta el mes que viene.</small>
    <p><strong>Este mes:</strong> {dollars.format(used.spentUsd)} de {dollars.format(state.monthlyUsd)} ({share} %) · {tokens.format(used.inputTokens)} tokens de entrada · {tokens.format(used.calls)} {used.calls === 1 ? 'llamada' : 'llamadas'}</p>
    <h3>Dónde puede decidir</h3>
    <ul className="install-list">{points.map(point => <li key={point} className="install-row">
      <label className="check"><input type="checkbox" checked={state.points[point]} disabled={busy !== null} onChange={event => togglePoint(point, event.target.checked)}/> {state.pointLabels[point] ?? point}</label>
    </li>)}</ul>
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
