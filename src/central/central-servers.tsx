import { useState, type ReactNode } from 'react';
import { getCentralServer, getCentralView, levelLabels, type CentralLevel, type CentralServerRecord } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem } from './central-connect';
import { OpenInCentral } from './open-in-central';
import { Block, RecordLayout } from './central-record';
import { dateLabel, levelTone, useCentralRead, viewKey } from './use-central-view';

const pct = (value: number | null | undefined) => (value == null ? '—' : `${Math.round(value)} %`);
const NONE = 'Sin dato';
const figureTone: Record<CentralLevel, string> = { green: 'good', amber: 'warn', red: 'bad', grey: '' };

function Level({ level }: { level: CentralLevel }) {
  return <span className={`status-badge ${levelTone[level]}`}>{levelLabels[level]}</span>;
}

function Tile({ label, level, value, note }: { label: string; level?: CentralLevel; value: ReactNode; note?: ReactNode }) {
  return <div className={`central-figure ${figureTone[level ?? 'grey']}`}>
    <span className="central-figure-label">{label}</span>
    <span className="central-figure-value">{value}</span>
    {note && <small>{note}</small>}
  </div>;
}

/** The health cards of a server, as Central's own record shows them; the ones without data say «Sin dato». */
function ServerCards({ server }: { server: CentralServerRecord }) {
  const c = server.cards;
  const services = c.services;
  const servicesNote = services ? [services.down.length && `${services.down.length} caídos`, services.stopped.length && `${services.stopped.length} parados`]
    .filter(Boolean).join(' · ') || 'todos en marcha' : 'necesita la lectura de root';
  const webs = c.webs ? (c.webs.down ? `${c.webs.down} caídas` : c.webs.slow ? `${c.webs.slow} lentas` : 'En línea') : NONE;
  const maintenance = c.maintenance ? (c.maintenance.reboot ? 'Reinicio pendiente' : c.maintenance.security ? `${c.maintenance.security} de seguridad` : 'Al día') : NONE;
  return <div className="central-figures">
    <Tile label="Procesador" level={c.cpu?.level} value={c.cpu ? pct(c.cpu.pct) : NONE}/>
    <Tile label="Memoria" level={c.memory?.level} value={c.memory ? pct(c.memory.pct) : NONE}/>
    <Tile label="Disco" level={c.disk?.level} value={c.disk ? pct(c.disk.pct) : NONE}/>
    <Tile label="Servicios" level={services?.level} value={services ? `${services.ok ?? '—'}/${services.total ?? '—'}` : NONE} note={servicesNote}/>
    <Tile label="Webs del servidor" level={c.webs?.level} value={webs} note={c.certificate ? `SSL: ${c.certificate.days ?? '—'} días` : undefined}/>
    <Tile label="Dentro ahora" level={c.sessions?.level} value={c.sessions ? c.sessions.count ?? '—' : NONE}/>
    <Tile label="Intentos de acceso (1 h)" level={c.attempts?.level} value={c.attempts ? c.attempts.hour ?? '—' : NONE}
      note={c.attempts ? `${c.attempts.day ?? '—'} en 24 h` : undefined}/>
    <Tile label="Bloqueadas" level={c.banned?.level} value={c.banned ? c.banned.now ?? '—' : NONE}/>
    <Tile label="Puertos abiertos desde Internet" level={c.ports?.level} value={c.ports ? (c.ports.odd.length ? c.ports.odd.join(', ') : 'Solo los públicos') : NONE}
      note={c.ports?.exposed.join(', ') || undefined}/>
    <Tile label="Mantenimiento" level={c.maintenance?.level} value={maintenance}
      note={c.maintenance ? `${c.maintenance.pending ?? '—'} actualizaciones pendientes` : undefined}/>
    {server.protection && <Tile label="Protección" level={server.protection.level} value={`${server.protection.done ?? '—'}/${server.protection.total ?? '—'}`}
      note="comprobaciones que se han podido mirar"/>}
  </div>;
}

const containerState = (state: string | null) => (state === 'ok' ? ['good', 'En marcha'] : state === 'down' ? ['bad', 'Caído'] : state === 'stopped' ? ['waiting', 'Parado'] : ['neutral', state ?? '—']);
const checkOrder = (ok: boolean | null) => (ok === false ? 0 : ok === null ? 1 : 2);

/** A server's record: health cards, protection checks, containers, the domains its proxy serves and the projects it hosts. */
function ServerRecord({ id, discreet, onBack, onOpen }: { id: string; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(`servidor:${id}`, () => getCentralServer(id));
  const back = <button type="button" className="button" onClick={onBack}>Volver a la lista</button>;
  if (read.failure) return <><div className="actions central-actions">{back}</div><CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/></>;
  if (!read.data) return <><div className="actions central-actions">{back}</div><Loading label="Leyendo la ficha del servidor" lines={4}/></>;
  const s = read.data;
  const checks = [...s.checks].sort((a, b) => checkOrder(a.ok) - checkOrder(b.ok));
  return <RecordLayout titleId="central-server-title" title={s.name}
    subtitle={`${[s.provider, s.panel].filter(Boolean).join(' · ') || '—'} · leído ${dateLabel(s.readAt ?? s.lastOkAt)}${s.root ? '' : ' · sin root'}`}
    badges={<><Level level={s.status}/><span className="chip">De Central</span></>}
    actions={<><OpenInCentral page={`servidores/${id}`} discreet={discreet}/>{back}</>}>
    {s.error && <p className="notice central-wide" role="status">{s.error}</p>}
    <Block title="Salud" wide><ServerCards server={s}/></Block>
    <Block title="Protección">
      {!checks.length ? <p className="muted">Aún sin lectura.</p> : <ul className="central-notes">{checks.map((c, index) => <li key={c.key ?? index}>
        <span className={`status-badge ${c.ok === true ? 'good' : c.ok === false ? 'bad' : 'neutral'}`}>{c.ok === true ? 'Bien' : c.ok === false ? 'Falta' : 'Sin dato'}</span>
        <p>{c.detail ?? c.key}{c.ok === null && ' · no se pudo mirar'}</p>
        {c.ok === false && c.fix && <code className="central-fix">{c.fix}</code>}
      </li>)}</ul>}
    </Block>
    <Block title="Dominios que sirve el proxy">
      {s.domains?.length ? <span className="central-chips">{s.domains.map(d => <span key={d} className="chip">{d}</span>)}</span> : <p className="muted">Sin datos.</p>}
    </Block>
    <Block title="Contenedores" wide>
      {!s.containers.length ? <p className="muted">Sin contenedores.</p> : <table className="data-table central-table">
        <thead><tr><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Detalle</th></tr></thead>
        <tbody>{s.containers.map((c, index) => {
          const [tone, text] = containerState(c.state);
          return <tr key={`${c.name}-${index}`}><td><strong>{c.name ?? '—'}</strong></td><td>{c.kind ?? '—'}</td>
            <td><span className={`status-badge ${tone}`}>{text}</span></td><td>{c.detail ?? ''}</td></tr>;
        })}</tbody></table>}
    </Block>
    <Block title="Proyectos que aloja" wide><ServerProjects server={s}/></Block>
    <p className="muted central-wide">Los servidores se cambian en Central: la API de escrituras no los toca.</p>
  </RecordLayout>;
}

function ServerProjects({ server }: { server: CentralServerRecord }) {
  if (!server.projects.length) return <p className="muted">Ningún servicio de proyecto asignado a este servidor.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Proyecto</th><th>Servicio</th><th>Contenedor</th><th>Dirección</th></tr></thead>
    <tbody>{server.projects.map((p, index) => <tr key={`${p.projectId}-${p.service}-${index}`}>
      <td><strong>{p.project ?? '—'}</strong></td><td>{p.service ?? '—'}{p.environment && ` · ${p.environment}`}</td>
      <td><span className="central-chips">{p.containers.length ? p.containers.map((c, i) => {
        const [tone, text] = containerState(c.state);
        return <span key={`${c.name}-${i}`} className={`status-badge ${tone}`} title={text}>{c.name ?? '—'}</span>;
      }) : '—'}</span></td>
      <td className="central-url">{p.url ?? '—'}</td>
    </tr>)}</tbody>
  </table>;
}

/** Servidores: each server's state, load, protection and the projects it hosts; «Ver ficha» opens its record. */
export function CentralServers({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const read = useCentralRead(viewKey('servidores'), () => getCentralView('servidores'));
  if (open) return <ServerRecord id={open} discreet={discreet} onBack={() => setOpen(null)} onOpen={onOpen}/>;
  if (read.failure) return <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo los servidores de Central" lines={4}/>;
  const servers = read.data.servers;
  if (!servers.length) return <p className="muted">Central no tiene servidores dados de alta.</p>;
  const bad = servers.filter(s => s.status === 'red' || s.status === 'grey').length;
  return <>
    <p className="muted">{servers.length} servidores · {bad} con algo que actuar o sin dato</p>
    <table className="data-table central-table">
      <thead><tr><th>Servidor</th><th>Estado</th><th className="num">CPU</th><th className="num">Memoria</th><th className="num">Disco</th><th>Servicios</th>
        <th>Protección</th><th>Proyectos</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
      <tbody>{servers.map((s, index) => <tr key={s.id ?? index}>
        <td><strong>{s.name ?? '—'}</strong>{(s.provider || s.panel) && <small className="muted"> · {[s.provider, s.panel].filter(Boolean).join(' · ')}</small>}
          {s.error && <small className="central-error">{s.error}</small>}</td>
        <td>{s.id && !discreet ? <OpenInCentral page={`servidores/${s.id}`} label={`Abrir ${s.name ?? 'el servidor'} en Central`} buttonClass="central-level-link"
          content={<Level level={s.status}/>}/> : <Level level={s.status}/>}</td>
        <td className="num">{pct(s.cpu)}</td><td className="num">{pct(s.memory)}</td><td className="num">{pct(s.disk)}</td>
        <td>{s.services ? `${s.services.ok ?? '—'}/${s.services.total ?? '—'}` : '—'}{s.services?.down.length ? <small className="muted"> · caídos: {s.services.down.join(', ')}</small> : null}</td>
        <td>{s.protection ? `${s.protection.done ?? '—'}/${s.protection.total ?? '—'}` : '—'}</td>
        <td>{[...new Set(s.projects.map(p => p.project).filter(Boolean))].join(', ') || '—'}</td>
        <td className="central-row-actions">{s.id && <span className="actions"><button type="button" className="button" onClick={() => setOpen(s.id)}>Ver ficha</button>
          <OpenInCentral page={`servidores/${s.id}`} discreet={discreet}/></span>}</td>
      </tr>)}</tbody>
    </table>
  </>;
}
