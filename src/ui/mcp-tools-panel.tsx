import { useEffect, useState } from 'react';
import { getMcpTools } from '../api/client';
import type { McpTools } from '../../shared/hermes-catalog';
import { McpCallForm } from './mcp-call-form';
import { Loading, LoadError } from './load-state';

export function McpToolsPanel({ profileId, serverId, profileLabel, enabled = true }: { profileId: string; serverId: string; profileLabel: string; enabled?: boolean }) {
  const [using, setUsing] = useState<string | null>(null);
  const [result, setResult] = useState<McpTools | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true; setResult(null); setError(''); setQuery('');
    getMcpTools(profileId, serverId).then(data => { if (live) setResult(data); })
      .catch(() => { if (live) setError('No se pudo leer el catálogo de herramientas de este perfil.'); });
    return () => { live = false; };
  }, [profileId, serverId, version]);
  const tools = result?.tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())) || [];
  return <section className="mcp-tools"><h3>Herramientas</h3>
    {error ? <LoadError message={error} onRetry={() => setVersion(value => value + 1)}/> : !result ? <Loading label="Leyendo catálogo local…"/> : <>
      <p>{({ cached: 'Catálogo guardado por Hermes; disponibilidad actual no comprobada.', expired: 'Catálogo caducado: se muestra como referencia histórica.', changed: 'La configuración cambió. El catálogo guardado no corresponde al servidor actual.', missing: 'Hermes no tiene un catálogo guardado para este servidor y perfil.', unavailable: 'El catálogo no es legible o tiene un formato no reconocido.' })[result.state]}</p>
      {result.recordedAt && <small>Registro: {new Date(result.recordedAt).toLocaleString()}</small>}
      {['cached', 'expired'].includes(result.state) && <><label className="mcp-search">Buscar herramienta<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre o descripción"/></label>
        <p>{tools.length} de {result.tools.length} herramientas{result.truncated ? ' · listado limitado' : ''}</p>
        {tools.map((tool, index) => <details key={`${tool.name}-${index}`}><summary>{tool.name}</summary><p>{tool.description || 'Sin descripción guardada.'}</p>
          <h4>Parámetros</h4>{tool.parameters.length ? <ul>{tool.parameters.map((parameter, i) => <li key={i}><strong>{parameter.name}</strong> · {parameter.type} · {parameter.required ? 'obligatorio' : 'opcional'}</li>)}</ul> : <p>Sin parámetros declarados en el esquema guardado.</p>}
          {!enabled ? <small>Servidor deshabilitado en Hermes para este perfil: no se puede usar.</small>
            : using === tool.name ? <McpCallForm profileId={profileId} serverId={serverId} profileLabel={profileLabel} tool={tool}/>
            : <button type="button" className="mcp-use" onClick={() => setUsing(tool.name)}>Usar esta herramienta</button>}
        </details>)}</>}
      <small>El catálogo es el que guardó Hermes. «Usar esta herramienta» conecta con el servicio con las credenciales de {profileLabel} y solo ejecuta tras revisar los datos y pulsar «Ejecutar».</small>
    </>}
  </section>;
}
