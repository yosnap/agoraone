import { useState } from 'react';
import { launchOrca, previewOrca, type OrcaAgent, type OrcaPreview, type OrcaProject, type OrcaSource } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import './orca.css';

const agents: { value: OrcaAgent; label: string }[] = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }];
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

/** Shared launch card of the Orca module: the user picks the project and the agent and writes the task, then sees
 * exactly which repository, agent and instructions will run; only «Lanzar en Orca» creates a new workspace there
 * with the agent started. Changing anything means a new preview. */
const keyOf = (c: OrcaProject) => JSON.stringify([c.client, c.project]);

export function OrcaLaunch({ choices, client, project: first, source, task: initialTask, agent: firstAgent = 'claude', onClose }: {
  choices: OrcaProject[]; client?: string; project?: string; source: OrcaSource; task: string; agent?: OrcaAgent; onClose: () => void;
}) {
  const [project, setProject] = useState(keyOf(choices.find(c => c.project === first && (!client || c.client === client)) ?? choices[0] ?? { client: '', project: '', repo: '' }));
  const [agent, setAgent] = useState<OrcaAgent>(firstAgent);
  const [task, setTask] = useState(initialTask);
  const [preview, setPreview] = useState<OrcaPreview | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = choices.find(c => keyOf(c) === project);
  // Each step replaces the buttons that had the focus: it goes to the new step's heading (no effect needed).
  const focus = (node: HTMLElement | null) => node?.focus();

  const prepare = async () => {
    if (!chosen) return;
    setBusy(true); setError('');
    try { setPreview(await previewOrca({ client: chosen.client, project: chosen.project, task, agent, source })); }
    catch (failure) { setError(message(failure, 'No se pudo preparar la vista previa.')); }
    finally { setBusy(false); }
  };
  const launch = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const started = await launchOrca(preview.id);
      setDone(`Lanzado en Orca: espacio de trabajo «${started.name}» en ${started.repo} con ${started.agentName}. Saldrá en «Agentes» en unos segundos.`);
    } catch (failure) {
      // The preview is used up either way: anything else needs a new one.
      setPreview(null);
      setError(message(failure, 'No se pudo lanzar en Orca.'));
    } finally { setBusy(false); }
  };

  if (done) return <div className="orca-launch" role="status">
    <p className="ok-note" tabIndex={-1} ref={focus}>{done}</p>
    <div className="orca-actions"><button type="button" className="button" onClick={onClose}>Cerrar</button></div>
  </div>;

  if (preview) return <div className="orca-launch" role="region" aria-label="Vista previa del lanzamiento en Orca">
    <strong tabIndex={-1} ref={focus}>Vista previa: esto es exactamente lo que se lanzará</strong>
    <dl className="orca-facts">
      <dt>Repositorio</dt><dd>{preview.repo} <span className="muted">· en Orca como «{preview.orcaName}»</span></dd>
      <dt>Proyecto</dt><dd>{preview.project} <span className="muted">· {preview.client}</span></dd>
      <dt>Agente</dt><dd>{preview.agentName}</dd>
      <dt>Espacio de trabajo</dt><dd>«{preview.name}», nuevo; no se toca ninguno que ya exista</dd>
      {preview.source && <><dt>Origen</dt><dd>{preview.source.label}</dd></>}
    </dl>
    <span className="muted">Indicaciones exactas que recibirá el agente:</span>
    <pre className="orca-prompt">{preview.prompt}</pre>
    {error && <LoadError message={error}/>}
    <div className="orca-actions">
      <button type="button" className="button primary" disabled={busy} onClick={() => void launch()}>{busy ? 'Lanzando…' : 'Lanzar en Orca'}</button>
      <button type="button" className="button" disabled={busy} onClick={() => setPreview(null)}>Cambiar</button>
      <button type="button" className="button" disabled={busy} onClick={onClose}>Cancelar</button>
    </div>
  </div>;

  return <form className="orca-launch" aria-label="Llevar a Orca" onSubmit={event => { event.preventDefault(); void prepare(); }}>
    <fieldset className="orca-fields" disabled={busy}>
    <div className="orca-grid">
      {choices.length > 1 ? <label className="field">Proyecto<ModernSelect value={project} onChange={setProject} disabled={busy}
        options={choices.map(c => ({ value: keyOf(c), label: `${c.client} › ${c.project} · ${c.repo}` }))}/></label>
        : <div className="field">Proyecto<span className="orca-fixed">{chosen ? `${chosen.project} · ${chosen.repo}` : '—'}</span></div>}
      <div className="field">Agente<div className="segmented" role="group" aria-label="Agente">{agents.map(a =>
        <button type="button" key={a.value} aria-pressed={agent === a.value} onClick={() => setAgent(a.value)}>{a.label}</button>)}</div></div>
    </div>
    <label className="field">Encargo para el agente<textarea value={task} rows={5} maxLength={4000} required placeholder="Qué quieres que haga en el repositorio"
      onChange={event => setTask(event.target.value)}/></label>
    </fieldset>
    {(source.kind === 'mail' || source.kind === 'note' || source.kind === 'chat') && <p className="muted">{{ mail: 'El correo', note: 'La nota (sin las líneas que parecen claves)',
      chat: 'La conversación de WhatsApp (los mensajes ya resumidos, tapando lo que parece un teléfono o un enlace)' }[source.kind]} irá debajo del encargo, marcado como datos: el agente no seguirá instrucciones que vengan dentro.</p>}
    {source.kind === 'issue' && <p className="muted">El agente leerá la issue con tu GitHub CLI y el espacio quedará enlazado a ella.</p>}
    {error && <LoadError message={error}/>}
    <div className="orca-actions">
      <button type="submit" className="button primary" disabled={busy || !chosen || !task.trim()}>{busy ? 'Preparando…' : 'Ver la vista previa'}</button>
      <button type="button" className="button" disabled={busy} onClick={onClose}>Cancelar</button>
    </div>
  </form>;
}
