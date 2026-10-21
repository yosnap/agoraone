import { Color } from 'three';
import type { HermesProfile } from '../../shared/hermes-catalog';
import type { BuildingStyle } from '../data/building-style';
import { WorldLabel } from './world-label';
import { SurfaceMaterial } from './surfaces';
import { hasWainscot, ProfileShell } from './profile-shell';
import { StandingPerson } from './standing-person';
import { decorObstacles, ProfileDecor, type Obstacle } from './profile-decor';
import type { ProfileActivity } from '../../shared/hermes-activity';
import { ActivityBoards } from './profile-activity-boards';
import { ago, mcpUsage, recentlyActive, usageLine } from '../data/activity-format';
import { Furniture, Glow, Rug, type Item } from './room-furniture';
import { SkillsShelf } from './skills-shelf';

const dayMs = 86_400_000;

export type ProfileRoom = {
  profile: HermesProfile; style: BuildingStyle; seed: number;
  services: { id: string; name: string; enabled: boolean }[];
};
export type RoomStation = 'identity' | 'memory' | 'chat' | 'skills';

export const profileObstacles: Obstacle[] = [
  { x: 0, z: -1.2, halfX: 1.6, halfZ: 0.9 },
  { x: -5.9, z: -2.5, halfX: 0.8, halfZ: 1.8 },
  { x: 4.5, z: 6.3, halfX: 1.6, halfZ: 0.55 },
  ...decorObstacles,
  ...[-6.2, 6.2].flatMap(x => [-7.1, 6.9].map(z => ({ x, z, halfX: 0.45, halfZ: 0.45 }))),
];

// Same furnishing in every profile's space: plants in the corners, things on the desk, pictures.
const furnishing: Item[] = [
  { model: 'plantTall', at: [-6.2, 0, -7.1] }, { model: 'plantTall', at: [6.2, 0, -7.1], turn: 2 },
  { model: 'plant', at: [-6.2, 0, 6.9] }, { model: 'plant', at: [6.2, 0, 6.9], turn: 1 },
  { model: 'laptop', at: [0.2, 1, -1.35], turn: Math.PI }, { model: 'deskLamp', at: [1.25, 1, -1.55], turn: Math.PI + 0.5 },
  { model: 'bookSet', at: [-1.05, 1, -1.6], turn: 0.1 }, { model: 'vase', at: [-1.35, 1, -0.75] },
];
// Pictures on the left wall, in front of the archive's wainscot and flush with the wall elsewhere.
const pictures = (x: number): Item[] => [
  { model: 'fancyFrame', at: [x, 2.1, 2.0], turn: Math.PI / 2, scale: 1.6 }, { model: 'fancyFrame', at: [x, 2.3, 4.6], turn: Math.PI / 2, scale: 1.2 },
];
const furnished = { plain: [...furnishing, ...pictures(-6.83)], wainscot: [...furnishing, ...pictures(-6.78)] };

const fileLabel = (profile: HermesProfile, name: string) => {
  const file = profile.files.find(item => item.name === name);
  return !file ? 'sin datos' : file.state === 'available' ? `${file.bytes ?? 0} bytes` : file.state === 'missing' ? 'no encontrado' : 'no legible';
};

// Each profile's own space, built from real catalog data (files, MCP declarations).
// Read-only: stations open the existing panels; nothing here starts the agent.
export function ProfileInterior({ room, activity, onStation, onService, onExit }: {
  room: ProfileRoom; activity?: ProfileActivity; onStation: (station: RoomStation) => void; onService: (id: string) => void; onExit: () => void;
}) {
  const { profile, style, seed, services } = room;
  const accent = profile.color;
  return <group>
    <ProfileShell style={style} accent={accent}/>
    {/* In front of the archive's wainscot, flush with the wall elsewhere. */}
    <mesh position={[0, 0.5, hasWainscot(style) ? -7.77 : -7.83]}><boxGeometry args={[14, 1, 0.04]}/><meshStandardMaterial color={accent} roughness={0.8}/></mesh>

    {/* Identity: the profile's SOUL as a framed portrait on the back wall. */}
    <group position={[0, 2.7, -7.75]} onClick={event => { event.stopPropagation(); onStation('identity'); }}>
      <mesh castShadow><boxGeometry args={[3.4, 2.2, 0.12]}/><meshStandardMaterial color="#3a2f24" roughness={0.6}/></mesh>
      <mesh position={[0, 0, 0.07]}><boxGeometry args={[3, 1.8, 0.02]}/><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.12} roughness={0.9}/></mesh>
      {/* A stylised portrait: a silhouette in the profile's colour against a lighter halo. */}
      <mesh position={[0, 0.05, 0.085]}><circleGeometry args={[0.78, 48]}/><meshStandardMaterial color="#f6efe0" transparent opacity={0.55} roughness={1}/></mesh>
      <mesh position={[0, 0.22, 0.095]}><circleGeometry args={[0.3, 40]}/><meshStandardMaterial color="#2c2620" roughness={1}/></mesh>
      <mesh position={[0, -0.9, 0.095]}><circleGeometry args={[0.62, 48, 0, Math.PI]}/><meshStandardMaterial color="#2c2620" roughness={1}/></mesh>
      <WorldLabel position={[0, 1.4, 0.3]} distanceFactor={11}><button className="place-label" onClick={() => onStation('identity')}>Personalidad · {fileLabel(profile, 'SOUL.md')}</button></WorldLabel>
    </group>

    {/* Memory: archive cabinet holding MEMORY.md and USER.md. */}
    <group position={[-5.9, 0, -2.5]} onClick={event => { event.stopPropagation(); onStation('memory'); }}>
      <mesh position={[0, 1.2, 0]} castShadow receiveShadow><boxGeometry args={[1.2, 2.4, 3.4]}/><SurfaceMaterial kind="wood" color="#b88d62"/></mesh>
      {[0.5, 1.1, 1.7].flatMap(y => [-0.8, 0.8].map(z => <mesh key={`${y}${z}`} position={[0.62, y, z]}><boxGeometry args={[0.04, 0.45, 1.4]}/><meshStandardMaterial color="#8a6643" roughness={0.6}/></mesh>))}
      <WorldLabel position={[0.8, 2.75, 0]} distanceFactor={10}><button className="place-label" onClick={() => onStation('memory')}>Recuerdos · {fileLabel(profile, 'MEMORY.md')} · Lo que sabe de ti · {fileLabel(profile, 'USER.md')}</button></WorldLabel>
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
    {/* The observatory's floor compass already marks this spot; a rug would cover it. */}
    {style !== 'observatory' && <Rug at={[0, -1.6]} size={[5.4, 3.6]} color={`#${new Color(accent).lerp(new Color('#3a2f24'), 0.45).getHexString()}`} border="#3a2f24"/>}
    <Furniture items={hasWainscot(style) ? furnished.wainscot : furnished.plain}/>
    <Glow at={[1.1, 1.6, -1.3]} intensity={4} distance={4}/>
    <StandingPerson seed={seed} color={accent} position={[0, 0, -2.5]} onClick={() => onStation('chat')}/>
    {recentlyActive(activity) && <WorldLabel position={[0, 2.25, -2.5]} distanceFactor={9}><span className="activity-chip" title="Dato real de las sesiones de Hermes"><strong>Actividad registrada {ago(activity?.lastActivityAt ?? null)}</strong></span></WorldLabel>}

    {/* Skills: the profile's real skills as books, coloured by category; the sign opens the skills sheet. */}
    <SkillsShelf x={4.5} z={6.3} profileId={profile.id} onShelf={() => onStation('skills')}/>
    <ActivityBoards activity={activity}/>
    <ProfileDecor style={style} accent={accent}/>
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.2, 3.4, 0.12]}/><SurfaceMaterial kind="wood" color="#a77f58"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
  </group>;
}
