import { useRef, useState } from 'react';
import { getWaitingSessions, handoffIssue, type OrcaProject, type WaitingSession } from '../api/core';
import { OrcaLaunch } from './orca-launch';

const tools = { claude: 'Claude Code', codex: 'Codex' };

/** A session already open in Orca for this repository that waits for you: AgoraOne types one line that points to
 * the issue into its prompt, without sending it (you press Enter in Orca), and puts it on screen. */
function ToOpenSession({ repo, url, onClose }: { repo: string; url: string; onClose: () => void }) {
  const [found, setFound] = useState<{ sessions: WaitingSession[]; line: string | null } | null>(null);
  const [chosen, setChosen] = useState('');
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string }>({});
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); };
  const asked = useRef(false);
  const look = () => { setFound(null); setState({}); void getWaitingSessions(repo, url).then(next => { setFound(next); setChosen(next.sessions[0]?.id ?? ''); })
    .catch(failure => setState({ error: failure instanceof Error ? failure.message : 'No se pudieron leer las sesiones de Orca.' })); };
  if (!asked.current) { asked.current = true; look(); }
  const send = async () => {
    setState({ busy: true });
    try { await handoffIssue(repo, url, chosen); setState({ done: 'Escrito en la sesión, sin enviar: revísalo en Orca y pulsa Enter allí.' }); }
    catch (failure) { setState({ error: failure instanceof Error ? failure.message : 'No se pudo escribir en la sesión.' }); }
  };
  if (state.done) return <p className="ok-note" role="status">{state.done} <button type="button" className="button" onClick={onClose}>Cerrar</button></p>;
  return <div className="issue-handoff" role="group" aria-label="Llevar la issue a una sesión abierta">
    {!found && !state.error && <small className="muted">Buscando sesiones de {repo} que te esperan en Orca…</small>}
    {found && found.sessions.length === 0 && <p className="muted">Ninguna sesión de {repo} te está esperando en Orca ahora (las que trabajan no se tocan). <button type="button" className="button" onClick={look}>Volver a mirar</button></p>}
    {found && found.sessions.length > 0 && <>
      <fieldset className="issue-sessions"><legend>Sesiones que te esperan</legend>
        {found.sessions.map(s => <label key={s.id} className="check"><input type="radio" name={`handoff-${url}`} checked={chosen === s.id} onChange={() => setChosen(s.id)}/>
          {' '}{tools[s.tool]} · {s.project ?? 'sin carpeta'}{s.branch ? ` · ${s.branch}` : ''}</label>)}
      </fieldset>
      <small>Se escribirá en su prompt, sin enviarlo (solo si en ese espacio hay una única terminal con un agente y nadie trabaja):</small>
      <pre className="issue-body">{found.line}</pre>
    </>}
    {state.error && <small className="dictation-error" role="alert">{state.error}</small>}
    <div className="inbox-actions">
      {found && found.sessions.length > 0 && <button type="button" className="button primary" disabled={state.busy || !chosen} onClick={() => void send()}>{state.busy ? 'Escribiendo…' : 'Escribir en la sesión'}</button>}
      {found?.line && <button type="button" className="button" onClick={() => copy(found.line!)}>{copied ? 'Copiada' : 'Copiar la línea'}</button>}
      <button type="button" className="button" disabled={state.busy} onClick={onClose}>Cancelar</button>
    </div>
  </div>;
}

/** After an issue is created: to a session already open in Orca (waiting for you), or to a new workspace. */
export function IssueToOrca({ repo, url, choices }: { repo: string; url: string; choices: OrcaProject[] }) {
  const [way, setWay] = useState<'open' | 'new' | null>(null);
  if (!choices.length) return null;
  if (way === 'open') return <ToOpenSession repo={repo} url={url} onClose={() => setWay(null)}/>;
  if (way === 'new') return <OrcaLaunch choices={choices} source={{ kind: 'issue', url }} task="Resuelve la issue enlazada. Antes de cambiar nada, explica tu plan." onClose={() => setWay(null)}/>;
  return <div className="inbox-actions">
    <button type="button" className="button" onClick={() => setWay('open')}>En una sesión abierta de Orca…</button>
    <button type="button" className="button" onClick={() => setWay('new')}>En un espacio nuevo de Orca…</button>
  </div>;
}
