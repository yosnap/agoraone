import type { BuildingStyle } from '../data/building-style';
import { ModelInstances, type Placement } from './city-models';
import { SurfaceMaterial } from './surfaces';
import { Furniture, type Item } from './room-furniture';

type Vec3 = [number, number, number];
export type Obstacle = { x: number; z: number; halfX: number; halfZ: number };

// Decoration only: it sets the mood of each profile's space and grants no capability.
// Items sit in the front half of the room, leaving the central aisle and stations free.
const metal = <meshStandardMaterial color="#4c5b5e" metalness={0.6} roughness={0.35}/>;

function Box({ at, size, kind = 'wood', color, rotation }: { at: Vec3; size: Vec3; kind?: 'wood' | 'concrete' | 'stucco'; color?: string; rotation?: Vec3 }) {
  return <mesh position={at} rotation={rotation} castShadow receiveShadow><boxGeometry args={size}/><SurfaceMaterial kind={kind} color={color}/></mesh>;
}

const workshopStools: Item[] = [-3.7, 3.7].flatMap(x => [3, 4.3].map(z => ({ model: 'stool' as const, at: [x, 0, z] as Vec3, turn: x + z })));

function Workshop({ accent }: { accent: string }) {
  return <group>
    {[-4.6, 4.6].map(x => <group key={x} position={[x, 0, 3.6]}>
      <Box at={[0, 0.9, 0]} size={[1.2, 0.08, 3]}/>
      {[-1.3, 1.3].map(z => <mesh key={z} position={[0, 0.45, z]} castShadow><boxGeometry args={[1, 0.9, 0.08]}/>{metal}</mesh>)}
      <mesh position={[0, 1.05, -0.6]} castShadow><boxGeometry args={[0.5, 0.22, 0.35]}/><meshStandardMaterial color={accent} roughness={0.5}/></mesh>
      <mesh position={[0, 1.01, 0.6]} castShadow><cylinderGeometry args={[0.12, 0.12, 0.14, 16]}/>{metal}</mesh>
    </group>)}
    <Furniture items={workshopStools}/>
  </group>;
}

const observatoryLounge: Item[] = [{ model: 'loungeChair', at: [4.6, 0, 3.6], turn: -Math.PI / 2 - 0.3 }, { model: 'sideTable', at: [4.7, 0, 5] }, { model: 'instrument', at: [4.7, 0.55, 5], turn: -0.6 }];

function Observatory({ accent }: { accent: string }) {
  return <group><Furniture items={observatoryLounge}/><group position={[-4.6, 0, 3.6]}>
    {[0, 2.1, 4.2].map(a => <mesh key={a} position={[Math.sin(a) * 0.35, 0.55, -0.9 + Math.cos(a) * 0.35]} rotation={[Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3]} castShadow><cylinderGeometry args={[0.03, 0.03, 1.15, 8]}/>{metal}</mesh>)}
    <mesh position={[0, 1.35, -0.9]} rotation={[0.9, 0, 0.4]} castShadow><cylinderGeometry args={[0.16, 0.12, 1.6, 20]}/><meshStandardMaterial color={accent} metalness={0.5} roughness={0.3}/></mesh>
    <mesh position={[0, 0.95, 1.1]} castShadow><sphereGeometry args={[0.32, 32, 16]}/><meshStandardMaterial color="#2b4a6b" metalness={0.2} roughness={0.4}/></mesh>
    <mesh position={[0, 0.3, 1.1]}><cylinderGeometry args={[0.05, 0.25, 0.6, 12]}/>{metal}</mesh>
  </group></group>;
}

const gardenSeats: Item[] = [
      { model: 'greenChair', at: [-3.6, 0, 3.4], turn: Math.PI / 2 + 0.3 }, { model: 'greenChair', at: [3.6, 0, 3.4], turn: -Math.PI / 2 - 0.3 },
      { model: 'planter', at: [-4.6, 0, 5.95] }, { model: 'planter', at: [4.6, 0, 5.95] },
      { model: 'plant', at: [-3.6, 0, 4.9] }, { model: 'plant', at: [3.6, 0, 4.9] },
    ];

function Garden() {
  const pots: Placement[] = [[-4.6, 2.6], [-4.6, 5.2], [4.6, 2.6], [4.6, 5.2]].map(([x, z]) => ({ position: [x, 0.5, z], scale: 0.32, rotation: x + z }));
  return <group>
    {pots.map(({ position: [x, , z] }) => <Box key={`${x}${z}`} at={[x, 0.25, z]} size={[1, 0.5, 1]} kind="concrete" color="#c9b9a2"/>)}
    <ModelInstances model="olive" placements={pots}/>
    <Furniture items={gardenSeats}/>
  </group>;
}

const patioSets: Item[] = [-4.5, 4.5].flatMap(x => [2.9, 5.1].map(z => ({ model: 'patioSet' as const, at: [x, 0, z] as Vec3, turn: x > 0 ? Math.PI : 0 })));

function Pavilion({ accent }: { accent: string }) {
  return <group>
    <Furniture items={patioSets}/>
    {[-4.5, 4.5].map(x => <mesh key={x} position={[x, 0.013, 4]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[2.2, 4.4]}/><meshStandardMaterial color={accent} roughness={1}/></mesh>)}
  </group>;
}

const towerLounges: Item[] = [-1, 1].flatMap(side => [
      { model: 'sofa' as const, at: [side * 5.2, 0, 4] as Vec3, turn: side * -Math.PI / 2 },
      { model: 'modernTable' as const, at: [side * 4.2, 0, 4] as Vec3, turn: Math.PI / 2 },
      { model: 'modernChair' as const, at: [side * 3.75, 0, 2.6] as Vec3, turn: side * Math.PI / 2 },
      { model: 'vase' as const, at: [side * 4.2, 0.39, 4.1] as Vec3 },
    ]);

function Tower({ accent }: { accent: string }) {
  return <group>
    {[-1, 1].map(side => <group key={side} position={[side * 4.4, 0, 4]}>
      <mesh position={[0, 0.013, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[2.6, 3.6]}/><meshStandardMaterial color={accent} roughness={1}/></mesh>
    </group>)}
    <Furniture items={towerLounges}/>
  </group>;
}

const archiveCorner: Item[] = [
  { model: 'bookSet', at: [-4.5, 0.53, 3], turn: Math.PI / 2 }, { model: 'bookSet', at: [-4.5, 1.13, 4.5], turn: Math.PI / 2 },
  { model: 'rockingChair', at: [4.4, 0, 3.2], turn: -Math.PI / 2 - 0.5 }, { model: 'sideTable', at: [4.7, 0, 4.7] },
  { model: 'bust', at: [4.7, 0.55, 4.7], turn: -2.4 },
];

function Archive() {
  // An open bookcase (back, sides and shelves) so the books on it can be seen from the aisle.
  return <group>
    <group position={[-4.6, 0, 3.8]}>
      <Box at={[-0.27, 1.1, 0]} size={[0.06, 2.2, 3]}/>
      {[-1.47, 1.47].map(z => <Box key={z} at={[0, 1.1, z]} size={[0.6, 2.2, 0.06]}/>)}
      {[0.5, 1.1, 1.7, 2.2].map(y => <Box key={y} at={[0, y, 0]} size={[0.6, 0.05, 3]} color="#d8c7a8"/>)}
    </group>
    <Furniture items={archiveCorner}/>
  </group>;
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
