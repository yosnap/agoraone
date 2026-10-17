import { useEffect, useState } from 'react';
import type { HermesCatalog, HermesFile } from '../../shared/hermes-catalog';
import { getHermesProfile } from '../api/client';
import type { Status } from '../api/client';
import { ChatPanel } from './chat-panel';
import { serviceGroups } from '../data/service-groups';
import type { HermesActivity } from '../../shared/hermes-activity';
import { ActivitySection } from './activity-panel';

export type ProfileTab = 'info' | 'chat';

export function HermesPanel({ id, catalog, onSelect, status, onConnected, tab, onTab, inside, onEnter, activity }: {
  id: string; catalog: HermesCatalog; onSelect: (id: string) => void; status: Status | null; onConnected: () => void;
  tab: ProfileTab; onTab: (tab: ProfileTab) => void; inside: boolean; onEnter: () => void;
  activity: { activity: HermesActivity | null; error: boolean };
}) {
  const profile = catalog.profiles.find(item => item.id === id);
  const space = catalog.spaces.find(item => item.id === id);
  const [files, setFiles] = useState<HermesFile[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setFiles([]); setError('');
    if (!profile) return;
    setLoading(true);
    getHermesProfile(id).then(data => { if (live) setFiles(data.files); })
      .catch(() => { if (live) setError('No se pudo leer este perfil. Puede haber cambiado en Hermes.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, profile?.files.map(file => file.revision).join(',')]);
  return <div className="profile-panel">
    {profile && !inside && <button className="enter-library" onClick={onEnter}>Entrar en el espacio de {profile.label} →</button>}
    {profile && <nav className="library-tabs" aria-label="Acciones del perfil"><button aria-pressed={tab === 'info'} onClick={() => onTab('info')}>Ficha del perfil</button><button aria-pressed={tab === 'chat'} onClick={() => onTab('chat')}>Conversar con {profile.label}</button></nav>}
    {profile && <div className="chat-slot" style={{ display: tab === 'chat' ? 'flex' : 'none' }}><ChatPanel key={profile.id} profile={profile} status={status} onConnected={onConnected}/></div>}
    <div className="hermes-details" hidden={tab !== 'info'}>
    <p className="notice">Datos reales de Hermes · solo lectura. Esta ficha no inicia el agente ni activa sus herramientas.</p>
    {profile && <>
      <dl><dt>Perfil</dt><dd>{profile.name}{profile.active ? ' · selección CLI guardada' : ''}</dd>
        <dt>Identidad del agente</dt><dd>Representada desde este perfil y su SOUL. La actividad real aparece abajo, con su fuente.</dd>
        <dt>Bot de Desktop</dt><dd>{profile.botLabel ? `${profile.botLabel} · metadatos guardados; presencia actual en Desktop no verificada` : 'No detectado en las fuentes disponibles'}</dd>
        {profile.section && <><dt>Sección de Desktop</dt><dd>{profile.section}</dd></>}
        <dt>Descripción</dt><dd>{profile.descriptionSource}</dd>
      </dl>
      <ActivitySection activity={activity.activity?.profiles[id]} data={activity.activity} error={activity.error}/>
      <h3>Identidad y memoria</h3>
      <small>Abrir esta ficha solo lee archivos localmente. Se enviarán al proveedor únicamente al enviar un mensaje en la pestaña de conversación. Credenciales reconocibles se ocultan.</small>
      {loading && <p role="status">Leyendo archivos del perfil…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {files.map(file => <details key={file.name}><summary>{file.name} · {file.state === 'available' ? `${file.bytes} bytes` : file.state === 'missing' ? 'no encontrado' : 'no legible'}</summary>
        {file.state === 'available' && <pre>{file.content || '(vacío)'}</pre>}</details>)}
      <h3>Canales declarados</h3>
      {profile.channels.length ? <ul>{profile.channels.map(channel => <li key={channel.name}>{channel.name} · {channel.enabled ? 'habilitado en configuración' : 'sin habilitación explícita'}</li>)}</ul> : <p>No hay canales declarados en config.yaml. La configuración mediante variables de entorno no se inspecciona.</p>}
      <h3>Espacios vinculados</h3>
      <p>Las líneas de la ciudad representan relaciones declaradas, no actividad en tiempo real.</p>
      {catalog.spaces.filter(item => item.profileIds.includes(id)).map(item => <button className="catalog-link" key={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}
      <h3>Servicios MCP configurados</h3>
      {serviceGroups(catalog).filter(service => service.bindings.some(binding => binding.profile.id === id)).map(service => <button className="catalog-link" key={service.id} onClick={() => onSelect(service.id)}>{service.name} · {service.bindings.find(binding => binding.profile.id === id)?.server.enabled ? 'habilitado en configuración' : 'deshabilitado'}</button>)}
      {!profile.mcp?.length && <p>Sin servidores declarados en mcp_servers. No se han consultado servicios de plugins ni conexiones activas.</p>}
      <small>Perfil, identidad y bot tienen IDs distintos. No se han importado sus sesiones ni sus permisos de ejecución.</small>
    </>}
    {space && <><p>Fuente: {space.source === 'project' ? 'Proyecto declarado en projects.db' : space.source === 'repository' ? 'Repositorio registrado en projects.db' : 'Directorio de trabajo registrado en state.db'}.</p>
      <p>El edificio representa este recurso por ID. No mueve archivos ni concede acceso a la carpeta.</p>
      <h3>Perfiles relacionados</h3>{space.profileIds.map(profileId => <button className="catalog-link" key={profileId} onClick={() => onSelect(profileId)}>{catalog.profiles.find(item => item.id === profileId)?.label || 'Perfil no disponible'}</button>)}
    </>}
  </div></div>;
}
