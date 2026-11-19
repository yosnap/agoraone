import { useEffect, useState, type ComponentType } from 'react';
import { getBrainMcpSetup, getCostguardUsage, type AgentUsage, type BrainMcpSetup, type Connector } from '../api/core';
import { scopeLabels, type CentralScope, type CentralStatus } from '../api/central';
import { isCrmdevProbe } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading, LoadError } from '../ui/load-state';
import { ActionButton } from '../ui/action-button';

// What a connector adds to its card beyond the common skeleton, by id. A new connector without extras adds nothing.

export type ExtraProps = { connector: Connector; tested: unknown; onOpen: (section: Section) => void };
export type Extra = { Body?: ComponentType<ExtraProps>; keyPlaceholder?: string };

const tokens = (value: number) => value.toLocaleString('es-ES');
const quote = (value: string) => /^[\w./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

const centralScopes: CentralScope[] = ['lectura', 'presupuestos', 'escritura'];
const scopeMeaning: Record<CentralScope, string> = {
  lectura: 'clientes, proyectos, webs, servidores y agenda', presupuestos: 'ver y crear presupuestos en borrador',
  escritura: 'cambiar clientes, sus notas y el estado y la fase de un proyecto, viendo antes el cambio exacto',
};

const isCentralStatus = (value: unknown): value is CentralStatus =>
  typeof value === 'object' && value !== null && Array.isArray((value as CentralStatus).scopes);

/** Central: where the key is created and, after «Probar», what the key allows. */
export function CentralScopes({ tested }: ExtraProps) {
  return <>
    <p>La clave se crea en <strong>Ajustes › Apps conectadas</strong> de Central. Sin Central no se ven sus clientes ni sus presupuestos.</p>
    {isCentralStatus(tested) && <div>
      <p><strong>Central {tested.version ?? 'sin versión'}</strong>{tested.runtime ? ` · ${tested.runtime === 'local' ? 'en este equipo' : 'en un servidor'}` : ''}. Lo que permite la clave:</p>
      <ul className="install-list">{centralScopes.map(scope => <li key={scope} className="install-row">
        <span><span className={`status-badge ${tested.scopes.includes(scope) ? 'good' : 'paused'}`}>{tested.scopes.includes(scope) ? 'Sí' : 'No'}</span> {scopeLabels[scope]}</span>
        <small className="muted">{scopeMeaning[scope]}</small>
      </li>)}</ul>
    </div>}
  </>;
}

const crmdevTools: Record<string, string> = {
  list_projects: 'Proyectos', list_tasks: 'Tareas', list_tickets: 'Tickets', list_clients: 'Clientes', list_members: 'Miembros',
  get_project_time_report: 'Horas de un proyecto', create_task: 'Crear tareas', update_task: 'Cambiar tareas', update_project: 'Cambiar proyectos',
  create_client: 'Crear clientes', update_client: 'Cambiar clientes', update_ticket: 'Cambiar tickets',
};

/** CRMDev: where the organization key is created and, after «Probar», what AgoraOne reads with it. */
export function CrmdevTools({ tested }: ExtraProps) {
  return <>
    <p>La clave de organización se crea en <strong>Ajustes › API Keys</strong> de CRMDev (solo propietarios y administradores). AgoraOne lee
      proyectos, tareas, tickets, clientes y miembros; crea o cambia tareas, clientes, proyectos y tickets solo después de enseñarte el cambio
      exacto y de que lo confirmes, y nunca borra nada en CRMDev.</p>
    <p className="muted">CRMDev admite 10 consultas cada 10 segundos por clave, compartidas con cualquier otra app que use la misma clave (por
      ejemplo, Claude Code). AgoraOne guarda cada lista un minuto y, si CRMDev pide esperar, espera sin volver a preguntar.</p>
    {isCrmdevProbe(tested) && <div>
      <p><strong>Conectado: organización</strong>. Lo que AgoraOne usa:</p>
      {tested.tools.length || tested.unverified?.length ? <ul className="install-list">
        {tested.tools.map(tool => <li key={tool} className="install-row">
          <span><span className="status-badge good">Sí</span> {crmdevTools[tool] ?? tool}</span>
        </li>)}
        {(tested.unverified ?? []).map(tool => <li key={tool} className="install-row">
          <span><span className="status-badge paused">Al abrirlos</span> {crmdevTools[tool] ?? tool}</span>
          <small className="muted">dependen del módulo de soporte de tu plan: se comprueba al abrir su vista</small>
        </li>)}
      </ul> : <p className="muted">CRMDev no ofrece ninguna de las consultas que usa AgoraOne.</p>}
    </div>}
  </>;
}

/** CostGuard: the tokens each agent spent, read in read-only mode, once its data file is found. */
export function CostguardUsage({ connector }: ExtraProps) {
  const [hours, setHours] = useState(5);
  const [usage, setUsage] = useState<AgentUsage[] | null>(null);
  const [error, setError] = useState('');
  const found = ['detected', 'recording'].includes(connector.state.status);
  useEffect(() => {
    if (!found) return;
    let live = true;
    setUsage(null); setError('');
    getCostguardUsage(hours).then(data => { if (live) setUsage(data.agents); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'No se pudo leer CostGuard.'); });
    return () => { live = false; };
  }, [hours, found]);
  if (!found) return null;
  return <section className="connector-extra" aria-labelledby="costguard-usage">
    <div className="card-head"><h3 id="costguard-usage">Consumo de tokens</h3>
      <div className="segmented" role="group" aria-label="Periodo">{[5, 24].map(value =>
        <button key={value} type="button" aria-pressed={hours === value} onClick={() => setHours(value)}>{value} h</button>)}</div></div>
    {error ? <LoadError message={error}/> : !usage ? <Loading label="Leyendo CostGuard" lines={3}/> : !usage.length ? <p>Sin consumo en las últimas {hours} horas.</p>
      : <table className="data-table"><thead><tr><th>Agente</th><th className="num">Entrada</th><th className="num">Salida</th><th className="num">Caché</th><th className="num">Turnos</th></tr></thead>
        <tbody>{usage.map(row => <tr key={row.agent}><td>{row.agent}</td><td className="num">{tokens(row.input)}</td><td className="num">{tokens(row.output)}</td>
          <td className="num">{tokens(row.cacheRead + row.cacheWrite)}</td><td className="num">{tokens(row.turns)}</td></tr>)}</tbody></table>}
  </section>;
}

/** MCP del cerebro: nothing to connect, only the orders to run by hand for a Hermes profile. */
export function BrainMcp() {
  const [setup, setSetup] = useState<BrainMcpSetup | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    getBrainMcpSetup().then(found => { if (live) setSetup(found); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'No disponible.'); });
    return () => { live = false; };
  }, []);
  const command = setup && [
    `hermes -p <perfil> mcp add ${setup.name} --command ${setup.command ? quote(setup.command) : '"$(which uv)"'}`
      + Object.entries(setup.env).map(([key, value]) => ` --env ${key}=${quote(value)}`).join('')
      + ` --args ${setup.args.map(quote).join(' ')}`,
    `hermes -p <perfil> mcp test ${setup.name}`,
    'hermes -p <perfil> gateway restart',
  ].join('\n');
  const copy = () => { if (command) navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => undefined); };
  return <>
    <p>Ofrece tres herramientas a cualquier perfil de Hermes (por ejemplo, el bot central de Telegram): buscar en el cerebro, leer una nota y ver su estado. Nunca entrega notas privadas ni de solo este Mac, y funciona con AgoraOne cerrado.</p>
    <p>AgoraOne no escribe en la configuración de Hermes: ejecuta tú estas órdenes en tu terminal, cambiando <code>&lt;perfil&gt;</code> por el perfil que quieras.</p>
    {error ? <LoadError message={error}/> : !command ? <Loading label="Preparando la orden" lines={2}/> : <>
      <pre className="code-block">{command}</pre>
      <div className="actions"><ActionButton icon="copy" label="Copiar órdenes" busyLabel={copied && 'Copiado'} onClick={copy}/>
        <small className="muted">Usa el nombre {setup?.name}: así los chats de perfil no piden «Permitir» para estas tres herramientas.</small></div>
    </>}
  </>;
}

/** Mi fábrica: its panel lives in its own section. */
export function FabricaLink({ onOpen }: ExtraProps) {
  return <div className="actions"><ActionButton icon="link" label="Ir a Mi fábrica" onClick={() => onOpen('fabrica')}/>
    <small className="muted">AgoraOne solo comprueba si está y si responde en este equipo; no la arranca, detiene ni modifica.</small></div>;
}

export const extras: Record<string, Extra> = {
  central: { Body: CentralScopes, keyPlaceholder: 'cen_…' },
  crmdev: { Body: CrmdevTools, keyPlaceholder: 'crm_…' },
  costguard: { Body: CostguardUsage },
  'cerebro-mcp': { Body: BrainMcp },
  fabrica: { Body: FabricaLink },
};
