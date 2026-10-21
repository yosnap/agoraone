import { useState, type FormEvent } from 'react';
import { callMcpTool } from '../api/client';
import { ModernSelect } from './modern-select';
import type { McpTools } from '../../shared/hermes-catalog';

type Tool = McpTools['tools'][number];
type Parameter = Tool['parameters'][number];

/** Turns what the user typed into the value the tool expects; an empty optional field is left out. */
function value(parameter: Parameter, raw: string): unknown {
  if (raw === '') return undefined;
  if (parameter.type === 'integer' || parameter.type === 'number') {
    const number = Number(raw);
    if (!Number.isFinite(number) || (parameter.type === 'integer' && !Number.isInteger(number))) throw new Error(`«${parameter.name}» debe ser un número${parameter.type === 'integer' ? ' entero' : ''}.`);
    return number;
  }
  if (parameter.type === 'boolean') return raw === 'true';
  if (parameter.type === 'array' || parameter.type === 'object') {
    try { return JSON.parse(raw); } catch { throw new Error(`«${parameter.name}» debe escribirse en JSON (por ejemplo ${parameter.type === 'array' ? '["a", "b"]' : '{"clave": "valor"}'}).`); }
  }
  return raw;
}

// Calling one MCP tool by hand (user's decision, 18/10/2026): a form from the tool's saved schema, a review
// of exactly what will be sent, and an explicit «Ejecutar». It runs with the profile's credentials.
export function McpCallForm({ profileId, serverId, profileLabel, tool }: { profileId: string; serverId: string; profileLabel: string; tool: Tool }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<{ result: string; hidden: number; truncated: boolean } | null>(null);
  function check(event: FormEvent) {
    event.preventDefault(); setError(''); setAnswer(null);
    try {
      const args: Record<string, unknown> = {};
      for (const parameter of tool.parameters) {
        const item = value(parameter, fields[parameter.name] ?? '');
        if (item === undefined && parameter.required) throw new Error(`Falta «${parameter.name}», que es obligatorio.`);
        if (item !== undefined) args[parameter.name] = item;
      }
      setReview(args);
    } catch (e) { setError(e instanceof Error ? e.message : 'Revisa los datos.'); }
  }
  async function run() {
    if (!review) return;
    setRunning(true); setError('');
    try { setAnswer(await callMcpTool(profileId, serverId, tool.name, review)); setReview(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'La llamada falló.'); }
    finally { setRunning(false); }
  }
  const input = (parameter: Parameter) => {
    const id = `mcp-${tool.name}-${parameter.name}`, current = fields[parameter.name] ?? '';
    const set = (text: string) => { setFields({ ...fields, [parameter.name]: text }); setReview(null); };
    const label = <>{parameter.name}{parameter.required ? ' (obligatorio)' : ''}{parameter.description && <small>{parameter.description}</small>}</>;
    if (parameter.options?.length) return <label key={id} htmlFor={id}>{label}<ModernSelect id={id} value={current} onChange={set} options={[{ value: '', label: parameter.required ? 'Elige…' : 'Sin valor' }, ...parameter.options.map(option => ({ value: option, label: option }))]}/></label>;
    if (parameter.type === 'boolean') return <label key={id} htmlFor={id}>{label}<ModernSelect id={id} value={current} onChange={set} options={[{ value: '', label: parameter.required ? 'Elige…' : 'Sin valor' }, { value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }]}/></label>;
    if (parameter.type === 'array' || parameter.type === 'object') return <label key={id} htmlFor={id}>{label}<textarea id={id} value={current} placeholder="JSON" onChange={event => set(event.target.value)}/></label>;
    return <label key={id} htmlFor={id}>{label}<input id={id} type={parameter.type === 'integer' || parameter.type === 'number' ? 'number' : 'text'} value={current} onChange={event => set(event.target.value)}/></label>;
  };
  return <form className="mcp-call" onSubmit={check} aria-label={`Usar ${tool.name}`}>
    <fieldset disabled={running}>{tool.parameters.map(input)}</fieldset>
    {!tool.parameters.length && <p>Esta herramienta no declara parámetros.</p>}
    {!review && <button type="submit">Revisar antes de ejecutar</button>}
    {review && <div className="editor-confirm" role="group" aria-label="Confirmar ejecución">
      <p>Se llamará a <code>{tool.name}</code> con las credenciales de {profileLabel}. Puede cambiar cosas en el servicio, y no se puede deshacer desde AgoraOne. Se enviará exactamente esto:</p>
      <pre>{JSON.stringify(review, null, 1)}</pre>
      {/* The focus lands on «Volver», never on «Ejecutar»: a second Enter must not run an irreversible action. */}
      <div><button type="button" className="primary" disabled={running} onClick={run}>{running ? 'Ejecutando…' : 'Ejecutar'}</button><button type="button" autoFocus disabled={running} onClick={() => setReview(null)}>Volver</button></div>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    {answer && <section className="mcp-answer" aria-label="Resultado" aria-live="polite"><h4>Resultado</h4>
      {answer.hidden > 0 && <small>{answer.hidden === 1 ? 'Una línea que parece una clave está oculta.' : `${answer.hidden} líneas que parecen claves están ocultas.`}</small>}
      <pre>{answer.result || '(respuesta vacía)'}</pre>
      {answer.truncated && <small>Respuesta recortada a 50 000 caracteres.</small>}
    </section>}
  </form>;
}
