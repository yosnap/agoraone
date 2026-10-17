import type { HermesCatalog } from '../../shared/hermes-catalog';
import { serviceGroups } from '../data/service-groups';
import { useState } from 'react';
import { McpToolsPanel } from './mcp-tools-panel';

export function ResourcePanel({ id, catalog, onSelect }: { id: string; catalog: HermesCatalog; onSelect: (id: string) => void }) {
  const vault = catalog.vaults?.find(item => item.id === id);
  const service = serviceGroups(catalog).find(item => item.id === id);
  const [profileId, setProfileId] = useState('');
  const binding = service?.bindings.find(item => item.profile.id === profileId) || service?.bindings[0];
  return <div className="hermes-details">
    {vault && <><h3>Vault de Obsidian</h3><dl>
      <dt>Origen</dt><dd>Registro local de Obsidian</dd>
      <dt>Carpeta</dt><dd>{vault.available ? 'Presente en este equipo' : 'No disponible; podría estar en un volumen desconectado'}</dd>
      <dt>Acceso desde AgoraOne</dt><dd>Solo metadatos. Lectura de notas y adjuntos pendiente.</dd>
      <dt>Relación con perfiles</dt><dd>No verificada. El registro de Obsidian no indica qué agentes utilizan el vault.</dd>
    </dl><p>Este edificio representa tu vault real. No hemos leído notas, creado un índice ni enviado su contenido al modelo.</p></>}
    {service && <><h3>Configuración por perfil</h3><p>Las líneas muestran relaciones declaradas, no tráfico ni conexiones activas. El mismo nombre puede tener destinos o credenciales diferentes en cada perfil.</p>
      <label className="mcp-search">Perfil de Hermes<select value={binding?.profile.id || ''} onChange={event => setProfileId(event.target.value)}>{service.bindings.map(item => <option key={item.profile.id} value={item.profile.id}>{item.profile.label}</option>)}</select></label>
      {(binding ? [binding] : []).map(({ profile, server }) => <section key={server.id}><button className="catalog-link" onClick={() => onSelect(profile.id)}>Ver perfil · {profile.label}</button><dl>
        <dt>Configuración</dt><dd>{server.enabled ? 'Habilitado en Hermes' : 'Deshabilitado en Hermes'}</dd>
        <dt>Transporte declarado</dt><dd>{server.transport === 'stdio' ? 'Proceso local (stdio)' : server.transport === 'http' ? 'HTTP' : 'No reconocido'}</dd>
        <dt>Conexión actual</dt><dd>No comprobada</dd>
        <dt>Uso desde este chat</dt><dd>No habilitado en AgoraOne</dd>
      </dl><McpToolsPanel profileId={profile.id} serverId={server.id}/></section>)}
      <p>Fuente: mcp_servers de config.yaml. No incluye servicios aportados dinámicamente por plugins. No se han iniciado procesos MCP ni contactado plataformas.</p>
    </>}
  </div>;
}
