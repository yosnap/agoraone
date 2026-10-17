import type { BuildingStyle } from '../data/building-style';
import { ModelInstances, type Placement } from './city-models';
import { SurfaceMaterial } from './surfaces';

type Vec3 = [number, number, number];
export type Obstacle = { x: number; z: number; halfX: number; halfZ: number };

// Decoration only: it sets the mood of each profile's space and grants no capability.
// Items sit in the front half of the room, leaving the central aisle and stations free.
const metal = <meshStandardMaterial color="#4c5b5e" metalness={0.6} roughness={0.35}/>;

function Box({ at, size, kind = 'wood', color, rotation }: { at: Vec3; size: Vec3; kind?: 'wood' | 'concrete' | 'stucco'; color?: string; rotation?: Vec3 }) {
  return <mesh position={at} rotation={rotation} castShadow receiveShadow><boxGeometry args={size}/><SurfaceMaterial kind={kind} color={color}/></mesh>;
}

function Workshop({ accent }: { accent: string }) {
  return <group>
    {[-4.6, 4.6].map(x => <group key={x} position={[x, 0, 3.6]}>
      <Box at={[0, 0.9, 0]} size={[1.2, 0.08, 3]}/>
      {[-1.3, 1.3].map(z => <mesh key={z} position={[0, 0.45, z]} castShadow><boxGeometry args={[1, 0.9, 0.08]}/>{metal}</mesh>)}
      <mesh position={[0, 1.05, -0.6]} castShadow><boxGeometry args={[0.5, 0.22, 0.35]}/><meshStandardMaterial color={accent} roughness={0.5}/></mesh>
      <mesh position={[0, 1.01, 0.6]} castShadow><cylinderGeometry args={[0.12, 0.12, 0.14, 16]}/>{metal}</mesh>
    </group>)}
  </group>;
}

function Observatory({ accent }: { accent: string }) {
  return <group position={[-4.6, 0, 3.6]}>
    {[0, 2.1, 4.2].map(a => <mesh key={a} position={[Math.sin(a) * 0.35, 0.55, -0.9 + Math.cos(a) * 0.35]} rotation={[Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3]} castShadow><cylinderGeometry args={[0.03, 0.03, 1.15, 8]}/>{metal}</mesh>)}
    <mesh position={[0, 1.35, -0.9]} rotation={[0.9, 0, 0.4]} castShadow><cylinderGeometry args={[0.16, 0.12, 1.6, 20]}/><meshStandardMaterial color={accent} metalness={0.5} roughness={0.3}/></mesh>
    <mesh position={[0, 0.95, 1.1]} castShadow><sphereGeometry args={[0.32, 32, 16]}/><meshStandardMaterial color="#2b4a6b" metalness={0.2} roughness={0.4}/></mesh>
    <mesh position={[0, 0.3, 1.1]}><cylinderGeometry args={[0.05, 0.25, 0.6, 12]}/>{metal}</mesh>
  </group>;
}

function Garden() {
  const pots: Placement[] = [[-4.6, 2.6], [-4.6, 5.2], [4.6, 2.6], [4.6, 5.2]].map(([x, z]) => ({ position: [x, 0.5, z], scale: 0.32, rotation: x + z }));
  return <group>
    {pots.map(({ position: [x, , z] }) => <Box key={`${x}${z}`} at={[x, 0.25, z]} size={[1, 0.5, 1]} kind="concrete" color="#c9b9a2"/>)}
    <ModelInstances model="olive" placements={pots}/>
  </group>;
}

function Pavilion({ accent }: { accent: string }) {
  return <group>{[-4.4, 4.4].flatMap(x => [2.6, 4.2, 5.8].map(z => <group key={`${x}${z}`} position={[x, 0, z]}>
    <Box at={[0, 0.45, 0]} size={[1.6, 0.08, 0.5]}/>
    <mesh position={[0, 0.75, -0.24]} castShadow><boxGeometry args={[1.6, 0.5, 0.06]}/><meshStandardMaterial color={accent} roughness={0.7}/></mesh>
    {[-0.7, 0.7].map(leg => <mesh key={leg} position={[leg, 0.22, 0]}><boxGeometry args={[0.06, 0.44, 0.45]}/>{metal}</mesh>)}
  </group>))}</group>;
}

function Tower({ accent }: { accent: string }) {
  return <group>
    {[-4.4, 4.4].map(x => <group key={x} position={[x, 0, 4]}>
      <Box at={[0, 0.25, 0]} size={[2.2, 0.5, 1]} kind="stucco" color={accent}/>
      <Box at={[0, 0.65, -0.42]} size={[2.2, 0.6, 0.18]} kind="stucco" color={accent}/>
      <mesh position={[0, 0.3, 1.1]} castShadow><boxGeometry args={[1, 0.04, 0.6]}/><meshStandardMaterial color="#9fb7bd" metalness={0.6} roughness={0.08} transparent opacity={0.6}/></mesh>
    </group>)}
  </group>;
}

function Archive() {
  return <group>{[-4.6, 4.6].map(x => <group key={x} position={[x, 0, 3.8]}>
    <Box at={[0, 1.1, 0]} size={[0.6, 2.2, 3]}/>
    {[0.5, 1.1, 1.7].map(y => <Box key={y} at={[0, y, 0]} size={[0.66, 0.05, 3]} color="#d8c7a8"/>)}
  </group>)}</group>;
}

const shift = -1.6; // pulls the themed items into view from the entrance

function Themed({ style, accent }: { style: BuildingStyle; accent: string }) {
  if (style === 'workshop') return <Workshop accent={accent}/>;
  if (style === 'observatory') return <Observatory accent={accent}/>;
  if (style === 'garden') return <Garden/>;
  if (style === 'pavilion') return <Pavilion accent={accent}/>;
  if (style === 'tower') return <Tower accent={accent}/>;
  return <Archive/>;
}

export function ProfileDecor({ style, accent }: { style: BuildingStyle; accent: string }) {
  return <group position={[0, 0, shift]}><Themed style={style} accent={accent}/></group>;
}

/** Same footprint for every theme: two blocks either side of the central aisle. */
export const decorObstacles: Obstacle[] = [-4.5, 4.5].map(x => ({ x, z: 4 + shift, halfX: 1.3, halfZ: 2.2 }));
