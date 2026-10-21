import { useEffect, useState } from 'react';
import type { HermesCatalog, HermesFile } from '../../shared/hermes-catalog';
import { getHermesProfile, type ProfileLimits } from '../api/client';
import { ProfileFileEditor } from './profile-file-editor';
import type { DocumentSource, Status } from '../api/client';
import { ChatPanel, type ChatState } from './chat-panel';
import { serviceGroups } from '../data/service-groups';
import type { HermesActivity } from '../../shared/hermes-activity';
import { ActivitySection } from './activity-panel';
import { HiddenLines } from './hidden-lines';
import { ProfileSkills } from './profile-skills';

export type ProfileTab = 'info' | 'chat' | 'skills';

export const fileTitles: Record<HermesFile['name'], string> = { 'SOUL.md': 'Personalidad', 'USER.md': 'Lo que sabe de ti', 'MEMORY.md': 'Recuerdos' };

export function HermesPanel({ id, catalog, onSelect, status, onConnected, tab, onTab, inside, onEnter, activity, document, onDetach, onChatState }: {
  id: string; catalog: HermesCatalog; onSelect: (id: string) => void; status: Status | null; onConnected: () => void;
  tab: ProfileTab; onTab: (tab: ProfileTab) => void; inside: boolean; onEnter: () => void;
  activity: { activity: HermesActivity | null; error: boolean; reload?: () => void }; document?: DocumentSource; onDetach: () => void;
  onChatState?: (state: ChatState) => void;
}) {
  const profile = catalog.profiles.find(item => item.id === id);
  const space = catalog.spaces.find(item => item.id === id);
  const [files, setFiles] = useState<HermesFile[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [limits, setLimits] = useState<ProfileLimits | null>(null);
  const [editing, setEditing] = useState<HermesFile['name'] | null>(null);
  const [saved, setSaved] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setError(''); // files stay while reloading, so an open editor keeps its draft
    if (!profile) return;
    setLoading(true);
    getHermesProfile(id, revealed).then(data => { if (live) { setFiles(data.files); setLimits(data.limits); } })
      .catch(() => { if (live) setError('No se pudo leer este perfil. Puede haber cambiado en Hermes.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, revealed, version, profile?.files.map(file => file.revision).join(',')]);
  return <div className="profile-panel">
    {profile && !inside && <button className="enter-library" onClick={onEnter}>Entrar en el espacio de {profile.label} →</button>}
    {profile && <nav className="library-tabs" aria-label="Acciones del perfil"><button aria-pressed={tab === 'info'} onClick={() => onTab('info')}>Ficha del perfil</button><button aria-pressed={tab === 'chat'} onClick={() => onTab('chat')}>Conversar con {profile.label}</button><button aria-pressed={tab === 'skills'} onClick={() => onTab('skills')}>Skills de {profile.label}</button></nav>}
    {profile && <div className="chat-slot" style={{ display: tab === 'chat' ? 'flex' : 'none' }}><ChatPanel key={profile.id} profile={profile} status={status} onConnected={onConnected} document={document} onDetach={onDetach} onState={onChatState}/></div>}
    {profile && <div className="chat-slot" style={{ display: tab === 'skills' ? 'flex' : 'none' }}><ProfileSkills key={profile.id} profileId={profile.id}/></div>}
    <div className="hermes-details" hidden={tab !== 'info'}>
    <p className="notice">Datos reales de Hermes · solo lectura. Esta ficha no inicia el agente ni activa sus herramientas.</p>
    {profile && <>
      <dl><dt>Perfil</dt><dd>{profile.name}{profile.active ? ' · selección CLI guardada' : ''}</dd>
        <dt>Identidad del agente</dt><dd>Representada desde este perfil y su SOUL. La actividad real aparece abajo, con su fuente.</dd>
        <dt>Bot de Desktop</dt><dd>{profile.botLabel ? `${profile.botLabel} · metadatos guardados; presencia actual en Desktop no verificada` : 'No detectado en las fuentes disponibles'}</dd>
        {profile.section && <><dt>Sección de Desktop</dt><dd>{profile.section}</dd></>}
        <dt>Descripción</dt><dd>{profile.descriptionSource}</dd>
      </dl>
      <ActivitySection activity={activity.activity?.profiles[id]} data={activity.activity} error={activity.error} declared={profile.mcp?.map(server => server.name)} profileId={id} onChanged={activity.reload}/>
      <h3>Personalidad y memoria</h3>
      <small>Lo que este perfil sabe de sí mismo y de ti, leído de sus archivos de Hermes. Abrir esta ficha solo lee localmente; se envían al proveedor únicamente al enviar un mensaje en la conversación.</small>
      {loading && <p role="status">Leyendo archivos del perfil…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <HiddenLines count={files.reduce((sum, file) => sum + (file.hidden ?? 0), 0)} revealed={revealed} disabled={!!editing} onToggle={() => setRevealed(value => !value)}/>
      {saved && <p className="notice" role="status">{saved}</p>}
      {files.map(file => <details key={file.name}><summary>{fileTitles[file.name]} <small>{file.name}</small> · {file.state === 'available' ? `${file.bytes} bytes` : file.state === 'missing' ? 'no encontrado' : 'no legible'}</summary>
        {editing === file.name && limits ? <ProfileFileEditor profileId={id} file={file} title={fileTitles[file.name]} limit={file.name === 'SOUL.md' ? null : limits[file.name]}
          revealed={revealed} onCancel={() => setEditing(null)} onReload={() => { setEditing(null); setVersion(value => value + 1); }} onSaved={message => { setEditing(null); setSaved(message); setVersion(value => value + 1); }}/>
        : <>{file.state === 'available' && <pre>{file.content || '(vacío)'}</pre>}
          {file.state !== 'unavailable' && !editing && <button className="edit-file" onClick={() => { setSaved(''); setEditing(file.name); }}>{file.state === 'missing' ? 'Crear' : 'Editar'} {fileTitles[file.name].toLocaleLowerCase('es')}</button>}</>}
      </details>)}
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
