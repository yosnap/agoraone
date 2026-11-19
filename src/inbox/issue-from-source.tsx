import { useRef, useState } from 'react';
import { createIssue, getIssueTarget, type IssueSource } from '../api/core';
import { getClients } from '../api/clients';
import { IssueToOrca } from '../orca/issue-to-orca';
import { useOrcaProjects } from '../orca/orca-projects';
import { ModernSelect } from '../ui/modern-select';
import { ActionButton } from '../ui/action-button';

type Target = { repo: string | null; visibility: 'public' | 'private' | 'internal' | null };
const keyOf = (client: string, project: string) => JSON.stringify([client, project]);

/** A GitHub issue from a client's mail or a vault note (user's decision, 17/11/2026): the project of Central with a
 * repository, the exact title and text (editable), and «Crear la issue» with the user's own `gh`. Then it can go to a
 * session waiting in Orca or to a new workspace. Never from what is private: the core refuses it too. */
export function IssueFromSource({ source, client: firstClient, project: firstProject, title: firstTitle, body: firstBody, onClose }: {
  source: IssueSource; client?: string | null; project?: string | null; title: string; body: string; onClose: (note?: string) => void;
}) {
  const [projects, setProjects] = useState<{ client: string; project: string }[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [title, setTitle] = useState(firstTitle);
  const [body, setBody] = useState(firstBody);
  const [made, setMade] = useState<{ repo: string; url: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const orca = useOrcaProjects();
  const [centralOn, setCentralOn] = useState(true);
  const asked = useRef(false);
  const latest = useRef('');  // the project chosen last: an older answer must not paint its repository's warning
  const look = (key: string) => {
    setChosen(key); setTarget(null); latest.current = key;
    const [client, project] = JSON.parse(key) as [string, string];
    void getIssueTarget(client, project).then(found => { if (latest.current === key) setTarget(found); })
      .catch(() => { if (latest.current === key) setTarget({ repo: null, visibility: null }); });
  };
  if (!asked.current) {
    asked.current = true;
    void getClients().then(found => {
      const list = found.clients.flatMap(c => c.projects.filter(p => p.repo).map(p => ({ client: c.name, project: p.name })));
      setCentralOn(found.central.on);
      setProjects(list);
      const first = list.find(p => p.client === firstClient && p.project === firstProject) ?? list.find(p => p.client === firstClient) ?? list[0];  // the mail's own project first
      if (first) look(keyOf(first.client, first.project));
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer tus clientes.'));
  }
  const create = async () => {
    const [client, project] = JSON.parse(chosen) as [string, string];
    setBusy(true); setError('');
    try { setMade(await createIssue({ client, project, title: title.trim(), body, source })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'GitHub no creó la issue.'); }
    finally { setBusy(false); }
  };
  if (made) {
    const [client, project] = JSON.parse(chosen) as [string, string];
    const ready = orca.filter(p => p.client === client && p.project === project && p.repo.toLowerCase() === made.repo.toLowerCase());
    return <div className="project-note" role="status">
      <p className="ok-note">Issue creada en {made.repo}. <a href={made.url} target="_blank" rel="noopener noreferrer">Abrir en GitHub</a></p>
      <IssueToOrca repo={made.repo} url={made.url} choices={ready}/>
      <div className="inbox-actions"><ActionButton icon="close" label="Cerrar" onClick={() => onClose(`Issue creada en ${made.repo}.`)}/></div>
    </div>;
  }
  if (projects && projects.length === 0) return <p className="muted">{centralOn
    ? 'Ningún proyecto de Central tiene repositorio de GitHub.'
    : 'Tus clientes propios no tienen proyectos: una issue va al repositorio de un proyecto de Central, y Central está apagado en Conectores.'} <ActionButton icon="close" label="Cerrar" onClick={() => onClose()}/></p>;
  return <form className="project-note" aria-label="Crear issue" onSubmit={event => { event.preventDefault(); void create(); }}>
    {projects && <label className="field">Proyecto<ModernSelect value={chosen} onChange={look}
      options={projects.map(p => ({ value: keyOf(p.client, p.project), label: `${p.client} › ${p.project}` }))}/></label>}
    {target?.repo && (target.visibility === 'public' ? <small className="fiscal-warning" role="note">Repositorio PÚBLICO ({target.repo}): cualquiera en internet verá esta issue. Quita lo que no deba verse.</small>
      : <small className="muted">En {target.repo}{target.visibility === null ? ': no se ha podido saber si es público.' : ', privado: la verá quien tenga acceso.'}</small>)}
    <label className="field">Título<input value={title} maxLength={200} required onChange={event => setTitle(event.target.value)}/></label>
    <label className="field">Texto de la issue<textarea value={body} rows={10} onChange={event => setBody(event.target.value)}/></label>
    {error && <small className="dictation-error" role="alert">{error}</small>}
    <div className="inbox-actions">
      <button type="submit" className="button primary" disabled={busy || !target?.repo || !title.trim() || !body.trim()}>{busy ? 'Creando en GitHub…' : target?.visibility === 'public' ? 'Crear la issue pública' : 'Crear la issue'}</button>
      <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={() => onClose()}/>
    </div>
  </form>;
}
