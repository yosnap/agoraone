import { useState } from 'react';
import { getCentralClient, getCentralView, projectKindLabels, projectStatusLabels, type CentralNote as Note, type CentralWebsite } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem, FallbackNote } from './central-connect';
import { OpenInCentral } from './open-in-central';
import { useWritePermissions } from './central-change';
import { CentralEditClient } from './central-edit-client';
import { CentralNote } from './central-note';
import { Block, Facts, RecordLayout } from './central-record';
import { dateLabel, forgetCentral, useCentralRead, viewKey } from './use-central-view';

const HIDDEN = 'Oculto en modo discreto';

/** The health of some websites: up or down, answer code, time and days left of the certificate. */
export function WebsitesTable({ websites, discreet = false }: { websites: CentralWebsite[]; discreet?: boolean }) {
  if (!websites.length) return <p className="muted">Sin webs.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Web</th><th>Estado</th><th className="num">Código</th><th className="num">Tiempo</th><th className="num">Certificado</th><th>Comprobada</th>
      <th><span className="visually-hidden">Acciones</span></th></tr></thead>
    <tbody>{websites.map((w, index) => <tr key={w.id ?? index}>
      <td>{w.label && <strong>{w.label} </strong>}<span className="central-url">{w.url ?? 'Dirección oculta'}</span></td>
      <td><span className={`status-badge ${w.status === 'up' ? 'good' : w.status === 'down' ? 'bad' : 'neutral'}`}>{w.status === 'up' ? 'En marcha' : w.status === 'down' ? 'Caída' : 'Sin datos'}</span></td>
      <td className="num">{w.code ?? '—'}</td>
      <td className="num">{w.ms != null ? `${w.ms} ms` : '—'}</td>
      <td className="num">{w.sslDaysLeft != null ? `${w.sslDaysLeft} días` : '—'}</td>
      <td className="central-date">{dateLabel(w.checkedAt)}</td>
      <td className="central-row-actions"><OpenInCentral page="webs" discreet={discreet}/></td>
    </tr>)}</tbody>
  </table>;
}

/** Central's latest notes; hidden in discreet mode, like the contact. */
export function NotesList({ notes, discreet }: { notes: Note[]; discreet: boolean }) {
  if (discreet) return <p className="muted">{HIDDEN}.</p>;
  if (!notes.length) return <p className="muted">Sin notas.</p>;
  return <ul className="central-notes">{notes.map((n, index) => <li key={n.id ?? index}>
    <small className="muted">{dateLabel(n.createdAt)}{n.pinned ? ' · fijada' : ''}</small>
    <p>{n.body}</p>
  </li>)}</ul>;
}

type Editing = 'datos' | 'nota' | null;

/** A client's record: contact (hidden in discreet mode), projects, websites and notes. With a key that may write, its
 * data and a new note are changed here after seeing the exact change; the rest, with «Abrir en Central». */
function ClientRecord({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`cliente:${id}`, () => getCentralClient(id));
  const can = useWritePermissions();
  const [editing, setEditing] = useState<Editing>(null);
  const [said, setSaid] = useState('');
  const back = <button type="button" className="button" onClick={onBack}>Volver a la lista</button>;
  if (read.failure) return <><div className="actions central-actions">{back}</div><CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <><div className="actions central-actions">{back}</div><Loading label="Leyendo la ficha del cliente" lines={4}/></>;
  const c = read.data;
  const editable = !discreet && can.central && c.revision && c.id && c.editable ? { ...c, id: c.id, revision: c.revision, editable: c.editable } : null;
  const done = (text: string) => { setEditing(null); setSaid(text); forgetCentral(); };
  const open = (next: Editing) => { setSaid(''); setEditing(next); };
  const contact: [string, string][] = [['Correo', c.email || '—'], ['Teléfono', c.phone || '—'], ['NIF', c.taxId || '—'], ['Dirección', c.address || '—']];
  return <RecordLayout titleId="central-client-title" title={c.name} subtitle={c.company && c.company !== c.name ? c.company : undefined}
    badges={<span className="chip">De Central</span>} actions={<><OpenInCentral page={`clientes/${id}`} discreet={discreet}/>{back}</>}>
    <FallbackNote fallback={c.fallback}/>
    {said && <p className="ok-note central-wide" role="status">{said}</p>}
    <Block title="Datos y contacto" actions={editable && editing !== 'datos' && <button type="button" className="button" onClick={() => open('datos')}>Cambiar datos</button>}>
      {editable && editing === 'datos' ? <CentralEditClient key={editable.revision} client={editable} onDone={done} onCancel={() => setEditing(null)} onReview={forgetCentral}/>
        : <Facts items={[['Nombre', c.name ?? '—'], ['Empresa', c.company || '—'],
          ...(discreet ? [['Contacto', `${HIDDEN}: correo, teléfono, NIF y dirección.`] as [string, string]] : contact)]}/>}
    </Block>
    <Block title="Notas" actions={editable && editing !== 'nota' && <button type="button" className="button" onClick={() => open('nota')}>Añadir nota</button>}>
      {editable && editing === 'nota' && <CentralNote target="cliente" id={editable.id} onDone={done} onCancel={() => setEditing(null)}/>}
      <NotesList notes={c.notes} discreet={discreet}/>
    </Block>
    <Block title="Proyectos" wide>
      {!c.projects.length ? <p className="muted">Sin proyectos.</p> : <table className="data-table central-table">
        <thead><tr><th>Proyecto</th><th>Tipo</th><th>Estado</th><th>Fase</th><th>Versión</th><th>Repositorio</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
        <tbody>{c.projects.map((p, index) => <tr key={p.id ?? index}>
          <td><strong>{p.name}</strong></td><td>{projectKindLabels[p.kind ?? ''] ?? '—'}</td><td>{projectStatusLabels[p.status ?? ''] ?? p.status ?? '—'}</td>
          <td>{p.phase ?? '—'}</td><td>{p.version ?? '—'}</td><td>{p.repo ?? '—'}</td>
          <td className="central-row-actions">{p.id && <OpenInCentral page={`proyectos/${p.id}`} discreet={discreet}/>}</td>
        </tr>)}</tbody></table>}
    </Block>
    <Block title="Webs" wide><WebsitesTable websites={c.websites} discreet={discreet}/></Block>
    {!discreet && !can.central && can.problem && <p className="muted central-wide">{can.problem}</p>}
  </RecordLayout>;
}

/** Clientes: Central's clients (without contact in the list) and, on «Ver ficha», one client's record. */
export function CentralClients({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const read = useCentralRead(viewKey('clientes'), () => getCentralView('clientes'));
  if (open) return <ClientRecord id={open} discreet={discreet} onBack={() => setOpen(null)} onOpen={onOpen}/>;
  if (read.failure) return <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo los clientes de Central" lines={4}/>;
  const clients = read.data.clients;
  return <>
    <FallbackNote fallback={read.data.fallback}/>
    {!clients.length ? <p className="muted">Central no tiene clientes.</p> : <table className="data-table central-table">
      <thead><tr><th>Cliente</th><th>Empresa</th><th className="num">Proyectos</th><th className="num">Webs</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
      <tbody>{clients.map((c, index) => <tr key={c.id ?? index}>
        <td><strong>{c.name ?? '—'}</strong></td><td>{c.company && c.company !== c.name ? c.company : '—'}</td>
        <td className="num">{c.projects ?? '—'}</td><td className="num">{c.websites ?? '—'}</td>
        <td className="central-row-actions">{c.id && <span className="actions">
          <button type="button" className="button" onClick={() => setOpen(c.id)}>Ver ficha</button><OpenInCentral page={`clientes/${c.id}`} discreet={discreet}/></span>}</td>
      </tr>)}</tbody>
    </table>}
  </>;
}
