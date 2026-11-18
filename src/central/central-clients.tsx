import { useState } from 'react';
import { getCentralClient, getCentralView, projectKindLabels, projectStatusLabels, type CentralNote, type CentralWebsite } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem, FallbackNote } from './central-connect';
import { OpenInCentral } from './open-in-central';
import { dateLabel, useCentralRead, viewKey } from './use-central-view';

const HIDDEN = 'Oculto en modo discreto';

/** The health of some websites: up or down, answer code, time and days left of the certificate. */
export function WebsitesTable({ websites }: { websites: CentralWebsite[] }) {
  if (!websites.length) return <p className="muted">Sin webs.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Web</th><th>Estado</th><th className="num">Código</th><th className="num">Tiempo</th><th className="num">Certificado</th><th>Comprobada</th></tr></thead>
    <tbody>{websites.map((w, index) => <tr key={w.id ?? index}>
      <td>{w.label && <strong>{w.label} </strong>}<span className="central-url">{w.url ?? 'Dirección oculta'}</span></td>
      <td><span className={`status-badge ${w.status === 'up' ? 'good' : w.status === 'down' ? 'bad' : 'neutral'}`}>{w.status === 'up' ? 'En marcha' : w.status === 'down' ? 'Caída' : 'Sin datos'}</span></td>
      <td className="num">{w.code ?? '—'}</td>
      <td className="num">{w.ms != null ? `${w.ms} ms` : '—'}</td>
      <td className="num">{w.sslDaysLeft != null ? `${w.sslDaysLeft} días` : '—'}</td>
      <td>{dateLabel(w.checkedAt)}</td>
    </tr>)}</tbody>
  </table>;
}

/** Central's latest notes; hidden in discreet mode, like the contact. */
export function NotesList({ notes, discreet }: { notes: CentralNote[]; discreet: boolean }) {
  if (discreet) return <p className="muted">{HIDDEN}.</p>;
  if (!notes.length) return <p className="muted">Sin notas.</p>;
  return <ul className="central-notes">{notes.map((n, index) => <li key={n.id ?? index}>
    <small className="muted">{dateLabel(n.createdAt)}{n.pinned ? ' · fijada' : ''}</small>
    <p>{n.body}</p>
  </li>)}</ul>;
}

/** A client's record: contact (hidden in discreet mode), projects, websites and notes, read-only. */
function ClientRecord({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`cliente:${id}`, () => getCentralClient(id));
  const back = <div className="actions central-actions"><button type="button" className="button" onClick={onBack}>Volver a la lista</button></div>;
  if (read.failure) return <>{back}<CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <>{back}<Loading label="Leyendo la ficha del cliente" lines={4}/></>;
  const c = read.data;
  const contact: [string, string | null][] = [['Correo', c.email], ['Teléfono', c.phone], ['NIF', c.taxId], ['Dirección', c.address]];
  return <article className="card central-record" aria-labelledby="central-client-title">
    <div className="card-head"><div><h2 id="central-client-title">{c.name}</h2>{c.company && c.company !== c.name && <small className="muted">{c.company}</small>}</div>
      <span className="chip">De Central · solo lectura</span></div>
    <FallbackNote fallback={c.fallback}/>
    <section aria-label="Contacto"><h3>Contacto</h3>
      {discreet ? <p className="muted">{HIDDEN}: correo, teléfono, NIF y dirección.</p>
        : <dl className="central-facts">{contact.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>}
    </section>
    <section aria-label="Proyectos"><h3>Proyectos</h3>
      {!c.projects.length ? <p className="muted">Sin proyectos.</p> : <table className="data-table central-table">
        <thead><tr><th>Proyecto</th><th>Tipo</th><th>Estado</th><th>Fase</th><th>Versión</th><th>Repositorio</th></tr></thead>
        <tbody>{c.projects.map((p, index) => <tr key={p.id ?? index}>
          <td><strong>{p.name}</strong></td><td>{projectKindLabels[p.kind ?? ''] ?? '—'}</td><td>{projectStatusLabels[p.status ?? ''] ?? p.status ?? '—'}</td>
          <td>{p.phase ?? '—'}</td><td>{p.version ?? '—'}</td><td>{p.repo ?? '—'}</td>
        </tr>)}</tbody></table>}
    </section>
    <section aria-label="Webs"><h3>Webs</h3><WebsitesTable websites={c.websites}/></section>
    <section aria-label="Notas"><h3>Notas</h3><NotesList notes={c.notes} discreet={discreet}/></section>
    <OpenInCentral page={`clientes/${id}`} discreet={discreet}/>
    {back}
  </article>;
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
        <td className="central-row-actions">{c.id && <button type="button" className="button" onClick={() => setOpen(c.id)}>Ver ficha</button>}</td>
      </tr>)}</tbody>
    </table>}
  </>;
}
