import { WorldLabel } from './world-label';
import type { Place } from '../data/city';
import { BuildingModel } from './building-model';
import { styleLabels } from '../data/building-style';
import { Walker } from './walker';
import { RoundedBox } from '@react-three/drei';
import { textures } from './textures';
import { SurfaceMaterial } from './surfaces';
import type { ProfileActivity } from '../../shared/hermes-activity';
import { ago, platformName, platformStates, recentlyActive } from '../data/activity-format';

export function Building({ place, selected, onSelect, activity }: { place: Place; selected: boolean; onSelect: () => void; activity?: ProfileActivity }) {
  const style = place.buildingStyle || (place.id === 'library' ? 'library' : 'archive');
  // Real record, not ambient motion: lit only while Hermes logged activity in the last two minutes.
  const active = recentlyActive(activity);
  return <group position={place.position}>
    <mesh position={[0, 0.06, 0]} receiveShadow><boxGeometry args={[5.8, 0.12, 4.8]}/><SurfaceMaterial kind="concrete" color="#cfcbc0"/></mesh>
    <mesh position={[0, 0.16, 0]} receiveShadow castShadow><boxGeometry args={[5.4, 0.1, 4.4]}/><SurfaceMaterial kind="paving" color="#efe9dc"/></mesh>
    {active && <mesh position={[0, 0.215, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.95, 3.15, 64]}/><meshStandardMaterial color="#ffd27a" emissive="#ffb43d" emissiveIntensity={2.2} toneMapped={false}/></mesh>}
    {[-2.72, 2.72].map(x => <RoundedBox key={x} args={[0.32, 0.5, 3.9]} radius={0.12} smoothness={3} position={[x, 0.45, -0.25]} castShadow receiveShadow>
      <meshStandardMaterial color="#4f6e45" roughness={1} map={textures.grass()} bumpMap={textures.grass()} bumpScale={3}/></RoundedBox>)}
    <group onClick={event => { event.stopPropagation(); onSelect(); }}><BuildingModel style={style} color={place.color}/></group>
    <WorldLabel position={[0, 5, 0]} distanceFactor={28}>
      <div className="label-stack">
        <button title={`Apariencia: ${styleLabels[style]}`} data-building-style={style} className={`place-label ${selected ? 'selected' : ''}`} onClick={onSelect}>{place.name}</button>
        {activity && (active || activity.platforms.length > 0) && <span className="activity-chip" title="Dato real del gateway y las sesiones de Hermes">
          {activity.platforms.map(link => <span key={link.name}><i className={`link-dot ${link.state}`}/>{platformName(link.name)} · {platformStates[link.state]}</span>)}
          {active && <strong>Actividad registrada {ago(activity.lastActivityAt)}</strong>}
        </span>}
      </div>
    </WorldLabel>
    {place.character && <><Walker color={place.color} phase={place.position[0] + place.position[2]} selected={selected} onSelect={onSelect}/>
      <WorldLabel position={[0, 2.15, 3]} distanceFactor={25}><button className="character-label" onClick={onSelect}>{place.character}</button></WorldLabel></>}
  </group>;
}
