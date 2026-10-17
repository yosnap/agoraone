import { useMemo } from 'react';
import { BoxGeometry } from 'three';
import type { HermesProfile } from '../../shared/hermes-catalog';
import type { BuildingStyle } from '../data/building-style';
import { WorldLabel } from './world-label';
import { Pendant } from './library-interior';
import { meterUV, SurfaceMaterial } from './surfaces';
import { StandingPerson } from './standing-person';
import { decorObstacles, ProfileDecor, type Obstacle } from './profile-decor';
import type { ProfileActivity } from '../../shared/hermes-activity';
import { ActivityBoards } from './profile-activity-boards';
import { mcpUsage, usageLine } from '../data/activity-format';

const dayMs = 86_400_000;

export type ProfileRoom = {
  profile: HermesProfile; style: BuildingStyle; seed: number;
  services: { id: string; name: string; enabled: boolean }[];
};
export type RoomStation = 'identity' | 'memory' | 'chat';

export const profileObstacles: Obstacle[] = [
  { x: 0, z: -1.2, halfX: 1.6, halfZ: 0.9 },
  { x: -5.9, z: -2.5, halfX: 0.8, halfZ: 1.8 },
  ...decorObstacles,
];

const fileLabel = (profile: HermesProfile, name: string) => {
  const file = profile.files.find(item => item.name === name);
  return !file ? `${name} · sin datos` : file.state === 'available' ? `${name} · ${file.bytes ?? 0} bytes` : file.state === 'missing' ? `${name} · no encontrado` : `${name} · no legible`;
};

// Each profile's own space, built from real catalog data (files, MCP declarations).
// Read-only: stations open the existing panels; nothing here starts the agent.
export function ProfileInterior({ room, activity, onStation, onService, onExit }: {
  room: ProfileRoom; activity?: ProfileActivity; onStation: (station: RoomStation) => void; onService: (id: string) => void; onExit: () => void;
}) {
  const { profile, style, seed, services } = room;
  const accent = profile.color;
  const shell = useMemo(() => ({ floor: meterUV(new BoxGeometry(14, 0.24, 16)), side: meterUV(new BoxGeometry(0.3, 5, 16)), end: meterUV(new BoxGeometry(14, 5, 0.3)) }), []);
  const warm = style === 'workshop' || style === 'archive' ? 'concrete' : 'wood';
  return <group>
    <hemisphereLight args={['#fff6e6', '#8a7a62', 0.9]}/>
    <directionalLight position={[2, 6, 5]} intensity={1.2} castShadow/>
    <mesh geometry={shell.floor} position={[0, -0.12, 0]} receiveShadow><SurfaceMaterial kind={warm} color={warm === 'wood' ? '#ffffff' : '#c9c6bd'}/></mesh>
    <mesh position={[0, 5.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color="#e9e3d6" roughness={0.9}/></mesh>
    {[-7, 7].map(x => <mesh key={x} geometry={shell.side} position={[x, 2.5, 0]} receiveShadow><SurfaceMaterial kind="stucco" color="#efe9de"/></mesh>)}
    {[-8, 8].map(z => <mesh key={z} geometry={shell.end} position={[0, 2.5, z]} receiveShadow><SurfaceMaterial kind="stucco" color="#efe9de"/></mesh>)}
    <mesh position={[0, 0.5, -7.83]}><boxGeometry args={[14, 1, 0.04]}/><meshStandardMaterial color={accent} roughness={0.8}/></mesh>
    {[-3, 1.5, 5].map(z => <Pendant key={z} x={0} z={z}/>)}

    {/* Identity: the profile's SOUL as a framed portrait on the back wall. */}
    <group position={[0, 2.7, -7.75]} onClick={event => { event.stopPropagation(); onStation('identity'); }}>
      <mesh castShadow><boxGeometry args={[3.4, 2.2, 0.12]}/><meshStandardMaterial color="#3a2f24" roughness={0.6}/></mesh>
      <mesh position={[0, 0, 0.07]}><boxGeometry args={[3, 1.8, 0.02]}/><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.25} roughness={0.9}/></mesh>
      <WorldLabel position={[0, 1.4, 0.3]} distanceFactor={11}><button className="place-label" onClick={() => onStation('identity')}>Identidad · {fileLabel(profile, 'SOUL.md')}</button></WorldLabel>
    </group>

    {/* Memory: archive cabinet holding MEMORY.md and USER.md. */}
    <group position={[-5.9, 0, -2.5]} onClick={event => { event.stopPropagation(); onStation('memory'); }}>
      <mesh position={[0, 1.2, 0]} castShadow receiveShadow><boxGeometry args={[1.2, 2.4, 3.4]}/><SurfaceMaterial kind="wood" color="#b88d62"/></mesh>
      {[0.5, 1.1, 1.7].flatMap(y => [-0.8, 0.8].map(z => <mesh key={`${y}${z}`} position={[0.62, y, z]}><boxGeometry args={[0.04, 0.45, 1.4]}/><meshStandardMaterial color="#8a6643" roughness={0.6}/></mesh>))}
      <WorldLabel position={[0.8, 2.75, 0]} distanceFactor={10}><button className="place-label" onClick={() => onStation('memory')}>Memoria · {fileLabel(profile, 'MEMORY.md')} · {fileLabel(profile, 'USER.md')}</button></WorldLabel>
    </group>

    {/* Services: one screen per MCP declared for this profile; brighter when Hermes recorded a call in the last day. */}
    {services.slice(0, 6).map((service, i) => { const use = mcpUsage(activity, service.name); const lit = !!use?.lastUsedAt && Date.now() - Date.parse(use.lastUsedAt) < dayMs; return <group key={service.id} position={[6.78, 2.1, -5.5 + i * 2]} rotation={[0, -Math.PI / 2, 0]} onClick={event => { event.stopPropagation(); onService(service.id); }}>
      <mesh><boxGeometry args={[1.5, 0.95, 0.06]}/><meshStandardMaterial color="#1d2a2e" metalness={0.4} roughness={0.3}/></mesh>
      <mesh position={[0, 0, 0.035]}><boxGeometry args={[1.36, 0.82, 0.01]}/><meshStandardMaterial color={service.enabled ? '#6bc0cb' : '#56636a'} emissive={service.enabled ? '#2f7f8a' : '#1e2629'} emissiveIntensity={lit ? 2.2 : 0.8}/></mesh>
      <WorldLabel position={[0, 0.75, 0.1]} distanceFactor={9}><button className="place-label" onClick={() => onService(service.id)}>MCP · {service.name} · {service.enabled ? 'habilitado' : 'deshabilitado'}<br/><small>{usageLine(use, activity?.usage?.windowDays)}</small></button></WorldLabel>
    </group>; })}
    {!services.length && <WorldLabel position={[6.5, 2.2, -2]} distanceFactor={10}><span className="place-label">Sin servidores MCP declarados</span></WorldLabel>}

    {/* Desk with the profile's person: conversation starts only when the user sends a message. */}
    <group position={[0, 0, -1.2]}>
      <mesh position={[0, 0.95, 0]} castShadow receiveShadow><boxGeometry args={[3.2, 0.1, 1.5]}/><SurfaceMaterial kind="wood" color="#c79a6c"/></mesh>
      {[-1.4, 1.4].map(x => <mesh key={x} position={[x, 0.45, 0]} castShadow><boxGeometry args={[0.12, 0.9, 1.3]}/><meshStandardMaterial color="#3a3530" metalness={0.5} roughness={0.4}/></mesh>)}
      <WorldLabel position={[0, 1.25, 0.4]} distanceFactor={9}><button className="character-label" onClick={() => onStation('chat')}>Conversar con {profile.label}</button></WorldLabel>
    </group>
    <StandingPerson seed={seed} color={accent} position={[0, 0, -2.5]} onClick={() => onStation('chat')}/>

    <ActivityBoards activity={activity}/>
    <ProfileDecor style={style} accent={accent}/>
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.2, 3.4, 0.12]}/><SurfaceMaterial kind="wood" color="#a77f58"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
  </group>;
}
