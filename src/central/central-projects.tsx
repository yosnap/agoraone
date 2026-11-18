import { useState } from 'react';
import { deployLabels, getCentralProject, getCentralView, projectKindLabels, projectStatusLabels, type ProjectFilters } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { CentralProblem } from './central-connect';
import { OpenInCentral } from './open-in-central';
import { NotesList, WebsitesTable } from './central-clients';
import { useWritePermissions } from './central-change';
import { CentralEditProject } from './central-edit-project';
import { CentralNote } from './central-note';
import { Block, Facts, RecordLayout } from './central-record';
import { dateLabel, forgetCentral, useCentralRead, useCentralReadings, viewKey } from './use-central-view';

const ALL = '';
const PAGE = '50';
const label = (labels: Record<string, string>, value: string | null) => (value ? labels[value] ?? value : '—');

/** One page of the list, asked with the cursor of the previous one; the last page offers «Cargar más». */
function ProjectsPage({ filters, cursor, last, discreet, onMore, onPick, onOpen }: {
  filters: ProjectFilters; cursor?: string; last: boolean; discreet: boolean; onMore: (cursor: string) => void; onPick: (id: string) => void; onOpen: (section: Section) => void;
}) {
  const params = { ...filters, cursor, limite: PAGE };
  const read = useCentralRead(viewKey('proyectos', params), () => getCentralView('proyectos', params));
  if (read.failure) return <tbody><tr><td colSpan={6}><CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></td></tr></tbody>;
  if (!read.data) return <tbody><tr><td colSpan={6}><Loading label="Leyendo los proyectos de Central" lines={3}/></td></tr></tbody>;
  const { projects, nextCursor } = read.data;
  return <tbody>
    {!cursor && !projects.length && !nextCursor && <tr><td colSpan={6} className="muted">Ningún proyecto con estos filtros.</td></tr>}
    {projects.map((p, index) => <tr key={p.id ?? index}>
      <td><strong>{p.name ?? '—'}</strong>{p.framework && <small className="muted"> · {p.framework}</small>}</td>
      <td>{p.client ?? '—'}</td>
      <td>{label(projectStatusLabels, p.status)}</td>
      <td>{p.phase ?? '—'}</td>
      <td className="central-date">{dateLabel(p.lastActivity)}</td>
      <td className="central-row-actions">{p.id && <span className="actions"><button type="button" className="button" onClick={() => onPick(p.id!)}>Ver ficha</button>
        <OpenInCentral page={`proyectos/${p.id}`} discreet={discreet}/></span>}</td>
    </tr>)}
    {last && nextCursor && <tr><td colSpan={6} className="central-row-actions"><button type="button" className="button" onClick={() => onMore(nextCursor)}>Cargar más</button></td></tr>}
  </tbody>;
}

type Editing = 'estado' | 'nota' | null;

/** A project's record: deployment, services and health (its websites). Never its folders nor this machine's details.
 * With a key that may write, its state, phase and a new note are changed here after seeing the exact change. */
function ProjectRecord({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`proyecto:${id}`, () => getCentralProject(id));
  const can = useWritePermissions();
  const [editing, setEditing] = useState<Editing>(null);
  const [said, setSaid] = useState('');
  const back = <button type="button" className="button" onClick={onBack}>Volver a la lista</button>;
  if (read.failure) return <><div className="actions central-actions">{back}</div><CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <><div className="actions central-actions">{back}</div><Loading label="Leyendo la ficha del proyecto" lines={4}/></>;
  const p = read.data;
  const editable = !discreet && can.central && p.revision && p.id ? { ...p, id: p.id, revision: p.revision } : null;
  const done = (text: string) => { setEditing(null); setSaid(text); forgetCentral(); };
  const open = (next: Editing) => { setSaid(''); setEditing(next); };
  const state: [string, string][] = [['Estado', label(projectStatusLabels, p.status)], ['Fijado a mano', p.statusLocked ? 'Sí' : 'No'], ['Fase', p.phase ?? '—'],
    ['Tipo', label(projectKindLabels, p.kind)], ['Cliente', p.client?.name ?? '—']];
  const facts: [string, string][] = [
    ['Versión', p.version ?? '—'], ['Framework', p.framework ?? '—'], ['Stack', p.stack.join(', ') || '—'], ['Repositorio', p.repo ?? '—'],
    ['Rama principal', p.defaultBranch ?? '—'], ['Último commit', dateLabel(p.lastCommitAt)], ['Última actividad', dateLabel(p.lastActivity)],
    ['Auditoría de dependencias', dateLabel(p.auditedAt)],
  ];
  const deploy: [string, string][] = [['Estado', label(deployLabels, p.deploy.status)], ['Hosting', p.deploy.hosting ?? '—'],
    ['Versión en producción', p.deploy.version ?? '—'], ['Entornos', p.deploy.environments.join(', ') || '—']];
  return <RecordLayout titleId="central-project-title" title={p.name} subtitle={p.description ?? undefined} badges={<span className="chip">De Central</span>}
    actions={<><OpenInCentral page={`proyectos/${id}`} label="Abrir en Central (secretos, entornos…)" discreet={discreet}/>{back}</>}>
    {said && <p className="ok-note central-wide" role="status">{said}</p>}
    <Block title="Estado y fase" actions={editable && editing !== 'estado' && <button type="button" className="button" onClick={() => open('estado')}>Cambiar estado o fase</button>}>
      {editable && editing === 'estado' ? <CentralEditProject key={editable.revision} project={editable} onDone={done} onCancel={() => setEditing(null)} onReview={forgetCentral}/>
        : <Facts items={state}/>}
    </Block>
    <Block title="Código"><Facts items={facts}/></Block>
    <Block title="Despliegue"><Facts items={deploy}/></Block>
    <Block title="Notas" actions={editable && editing !== 'nota' && <button type="button" className="button" onClick={() => open('nota')}>Añadir nota</button>}>
      {editable && editing === 'nota' && <CentralNote target="proyecto" id={editable.id} onDone={done} onCancel={() => setEditing(null)}/>}
      <NotesList notes={p.notes} discreet={discreet}/>
    </Block>
    <Block title="Servicios" wide>
      {!p.services.length ? <p className="muted">Sin servicios.</p> : <table className="data-table central-table">
        <thead><tr><th>Servicio</th><th>Entorno</th><th>Dirección</th><th>Hosting</th><th>Versión en vivo</th></tr></thead>
        <tbody>{p.services.map((s, index) => <tr key={s.id ?? index}>
          <td><strong>{s.name ?? '—'}</strong></td><td>{s.environment ?? '—'}</td><td className="central-url">{s.url ?? '—'}</td><td>{s.hosting ?? '—'}</td>
          <td>{s.liveVersion ?? '—'}{s.liveVersionAt && <small className="muted"> · {dateLabel(s.liveVersionAt)}</small>}</td>
        </tr>)}</tbody></table>}
    </Block>
    <Block title="Salud" wide><WebsitesTable websites={p.websites} discreet={discreet}/></Block>
    {!discreet && !can.central && can.problem && <p className="muted central-wide">{can.problem}</p>}
  </RecordLayout>;
}

/** Proyectos: filters by state and client, a search, pages by Central's cursor and each project's record. */
export function CentralProjects({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [filters, setFilters] = useState<ProjectFilters>({});
  const [typed, setTyped] = useState('');
  // The cursors of the pages loaded, valid only for the reading they came from: «Volver a leer» starts at page one.
  const readings = useCentralReadings();
  const [paging, setPaging] = useState<{ readings: number; cursors: (string | undefined)[] }>({ readings, cursors: [undefined] });
  const cursors = paging.readings === readings ? paging.cursors : [undefined];
  const [open, setOpen] = useState<string | null>(null);
  const clients = useCentralRead(viewKey('clientes'), () => getCentralView('clientes'));
  const apply = (next: ProjectFilters) => { setFilters(next); setPaging({ readings, cursors: [undefined] }); };
  if (open) return <ProjectRecord id={open} discreet={discreet} onBack={() => setOpen(null)} onOpen={onOpen}/>;
  const names = [...new Set((clients.data?.clients ?? []).map(c => c.name).filter((n): n is string => Boolean(n)))];
  return <>
    <form className="field-row central-filters" onSubmit={event => { event.preventDefault(); apply({ ...filters, q: typed.trim() || undefined }); }}>
      <label className="field">Estado<ModernSelect value={filters.estado ?? ALL} onChange={value => apply({ ...filters, estado: value || undefined })}
        options={[{ value: ALL, label: 'Todos' }, ...Object.entries(projectStatusLabels).map(([value, text]) => ({ value, label: text }))]}/></label>
      <label className="field">Cliente<ModernSelect value={filters.cliente ?? ALL} onChange={value => apply({ ...filters, cliente: value || undefined })}
        options={[{ value: ALL, label: 'Todos' }, ...names.map(name => ({ value: name, label: name }))]}/></label>
      <label className="field">Buscar<input value={typed} maxLength={200} onChange={event => setTyped(event.target.value)} placeholder="Nombre o tecnología"/></label>
      <div className="actions central-actions"><button type="submit" className="button">Buscar</button></div>
    </form>
    <table className="data-table central-table">
      <thead><tr><th>Proyecto</th><th>Cliente</th><th>Estado</th><th>Fase</th><th>Última actividad</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
      {cursors.map((cursor, index) => <ProjectsPage key={cursor ?? 'first'} filters={filters} cursor={cursor} last={index === cursors.length - 1} discreet={discreet}
        onMore={next => setPaging({ readings, cursors: [...cursors, next] })} onPick={setOpen} onOpen={onOpen}/>)}
    </table>
  </>;
}
