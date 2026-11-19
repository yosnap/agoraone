import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { deleteConnector, getBrainMcpSetup, getConnectors, getCostguardUsage, putConnector, type AgentUsage, type BrainMcpSetup, type Connector, type ConnectorChanges,
  type ConnectorStatus } from '../api/core';
import { Loading, LoadError } from '../ui/load-state';

const statusText: Record<ConnectorStatus, [string, '' | 'good' | 'warn' | 'bad']> = {
  not_configured: ['Sin configurar', ''], not_found: ['No encontrado', 'bad'], unreadable: ['No se puede leer', 'bad'],
  detected: ['Detectado', 'warn'], responding: ['En marcha · responde', 'good'], recording: ['Registrando consumo', 'good'],
  legacy: ['Hay que volver a conectarlo', 'warn'], saved: ['Dirección y clave guardadas', 'good'], failing: ['No responde', 'bad'], guide: ['Guía', ''],
};
const tokens = (value: number) => value.toLocaleString('es-ES');
const quote = (value: string) => /^[\w./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** A connector of this computer: a panel on a local port (Mi fábrica) or a data file (CostGuard). */
function AddonCard({ addon, onSaved }: { addon: Connector; onSaved: (connector: Connector) => void }) {
  const file = addon.kind === 'local_file';
  const pathKey = file ? 'dataPath' : 'path';
  const [path, setPath] = useState(addon.state.configured[pathKey] ?? '');
  const [port, setPort] = useState(addon.state.configured.port ? String(addon.state.configured.port) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent, forget = false) => {
    event.preventDefault(); setBusy(true); setError('');
    const changes: ConnectorChanges = { [pathKey]: path.trim() || null, ...(!file ? { port: port.trim() ? Number(port) : null } : {}) };
    try { onSaved(await (forget ? deleteConnector(addon.id) : putConnector(addon.id, changes))); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const [label, tone] = statusText[addon.state.status];
  return <article className="card" aria-labelledby={`addon-${addon.id}`}>
    <div className="card-head"><h2 id={`addon-${addon.id}`}>{addon.name}</h2><span className={`chip ${tone}`}>{label}</span></div>
    <p>{addon.description}</p>
    <form className="field-row" onSubmit={save}>
      <label className="field">{file ? 'Archivo de datos' : 'Carpeta del proyecto'}
        <input value={path} onChange={event => setPath(event.target.value)} placeholder="/ruta/absoluta" spellCheck={false}/></label>
      {!file && <label className="field" style={{ flex: '0 1 110px' }}>Puerto
        <input value={port} onChange={event => setPort(event.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={5}/></label>}
      <div className="actions"><button className="button primary" disabled={busy}>Guardar</button>
        <button type="button" className="button" disabled={busy} onClick={event => void save(event, true)}>Olvidar</button></div>
    </form>
    {error && <LoadError message={error}/>}
    <small className="muted">AgoraOne solo comprueba si está y si responde en este Mac; no lo arranca, detiene ni modifica.</small>
  </article>;
}

function CostguardUsage() {
  const [hours, setHours] = useState(5);
  const [usage, setUsage] = useState<AgentUsage[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setUsage(null); setError('');
    getCostguardUsage(hours).then(data => { if (live) setUsage(data.agents); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'No se pudo leer CostGuard.'); });
    return () => { live = false; };
  }, [hours]);
  return <article className="card" aria-labelledby="costguard-usage">
    <div className="card-head"><h2 id="costguard-usage">Consumo de tokens</h2>
      <div className="segmented" role="group" aria-label="Periodo">{[5, 24].map(value =>
        <button key={value} aria-pressed={hours === value} onClick={() => setHours(value)}>{value} h</button>)}</div></div>
    {error ? <p>{error}</p> : !usage ? <Loading label="Leyendo CostGuard" lines={3}/> : !usage.length ? <p>Sin consumo en las últimas {hours} horas.</p>
      : <table className="data-table"><thead><tr><th>Agente</th><th className="num">Entrada</th><th className="num">Salida</th><th className="num">Caché</th><th className="num">Turnos</th></tr></thead>
        <tbody>{usage.map(row => <tr key={row.agent}><td>{row.agent}</td><td className="num">{tokens(row.input)}</td><td className="num">{tokens(row.output)}</td>
          <td className="num">{tokens(row.cacheRead + row.cacheWrite)}</td><td className="num">{tokens(row.turns)}</td></tr>)}</tbody></table>}
    <small className="muted">Leído en solo lectura de la base de CostGuard.</small>
  </article>;
}

function BrainMcp() {
  const [setup, setSetup] = useState<BrainMcpSetup | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { getBrainMcpSetup().then(setSetup).catch(failure => setError(failure instanceof Error ? failure.message : 'No disponible.')); }, []);
  const command = setup && [
    `hermes -p <perfil> mcp add ${setup.name} --command ${setup.command ? quote(setup.command) : '"$(which uv)"'}`
      + Object.entries(setup.env).map(([key, value]) => ` --env ${key}=${quote(value)}`).join('')
      + ` --args ${setup.args.map(quote).join(' ')}`,
    `hermes -p <perfil> mcp test ${setup.name}`,
    'hermes -p <perfil> gateway restart',
  ].join('\n');
  const copy = () => { if (command) navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => undefined); };
  return <article className="card brain-mcp-card" aria-labelledby="brain-mcp">
    <div className="card-head"><h2 id="brain-mcp">MCP del cerebro</h2><span className="chip">Solo lectura</span></div>
    <p>Ofrece tres herramientas a cualquier perfil de Hermes (por ejemplo, el bot central de Telegram): buscar en el cerebro, leer una nota y ver su estado. Nunca entrega notas privadas ni de solo este Mac, y funciona con AgoraOne cerrado.</p>
    <p>AgoraOne no escribe en la configuración de Hermes: ejecuta tú estas órdenes en tu terminal, cambiando <code>&lt;perfil&gt;</code> por el perfil que quieras.</p>
    {error ? <LoadError message={error}/> : !command ? <Loading label="Preparando la orden" lines={2}/> : <>
      <pre className="code-block">{command}</pre>
      <div className="actions"><button className="button" onClick={copy}>{copied ? 'Copiado' : 'Copiar órdenes'}</button>
        <small className="muted">Usa el nombre {setup?.name}: así los chats de perfil no piden «Permitir» para estas tres herramientas.</small></div>
    </>}
  </article>;
}

const local = (connector: Connector) => connector.kind === 'local_port' || connector.kind === 'local_file';

/** The connectors of this computer (CostGuard, my factory) and how to plug the brain into Hermes. */
export function ConnectorsView() {
  const [found, setFound] = useState<Connector[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { setError(''); getConnectors().then(data => setFound(data.connectors)).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer el registro.')); }, []);
  useEffect(load, [load]);
  const saved = (connector: Connector) => setFound(current => current?.map(item => item.id === connector.id ? connector : item) ?? null);
  const addons = found?.filter(local) ?? null;
  const costguard = addons?.find(addon => addon.id === 'costguard');
  return <section className="page" aria-labelledby="connectors-title">
    <div className="eyebrow">CONECTORES</div>
    <h1 id="connectors-title">Conectores</h1>
    <p className="page-lead">Lo que AgoraOne sabe de tus otras herramientas y cómo conectar el cerebro a Hermes. Las rutas y puertos se guardan solo en este Mac.</p>
    <div className="actions page-actions"><button className="button" onClick={load}>Comprobar de nuevo</button></div>
    {error ? <LoadError message={error} onRetry={load}/> : !addons ? <Loading label="Leyendo los complementos"/> : <div className="page-grid">
      {addons.map(addon => <AddonCard key={`${addon.id}:${addon.state.configured.path ?? addon.state.configured.dataPath ?? ''}`} addon={addon} onSaved={saved}/>)}
      {costguard && ['detected', 'recording'].includes(costguard.state.status) && <CostguardUsage/>}
      <BrainMcp/>
    </div>}
  </section>;
}
