import { useMemo, type ReactNode } from 'react';
import { BoxGeometry, Shape, Vector2 } from 'three';
import type { BuildingStyle } from '../data/building-style';
import { Pendant } from './library-interior';
import { meterUV, SurfaceMaterial, type SurfaceKind } from './surfaces';

// Architecture of each profile's space, chosen by its building type. Decoration only:
// every theme keeps the same 14 × 16 m footprint, so stations and obstacles never move.
type Vec3 = [number, number, number];
const glass = <meshStandardMaterial color="#cfe6ea" metalness={0.1} roughness={0.05} transparent opacity={0.22} depthWrite={false}/>;
const steel = <meshStandardMaterial color="#3d4447" metalness={0.7} roughness={0.35}/>;

export const shellBackground: Partial<Record<BuildingStyle, string>> = {
  workshop: '#2c3033', observatory: '#0f1422', garden: '#cfe3d4', pavilion: '#e8dcc8', tower: '#b9cad6',
};

function Bar({ at, size, children = steel, rotation }: { at: Vec3; size: Vec3; children?: ReactNode; rotation?: Vec3 }) {
  return <mesh position={at} rotation={rotation} castShadow><boxGeometry args={size}/>{children}</mesh>;
}

// Shared per wall height (only three are used), so revisiting a room never allocates again.
const rooms = new Map<number, Record<'floor' | 'side' | 'end', BoxGeometry>>();
function roomGeometry(height: number) {
  let shell = rooms.get(height);
  if (!shell) rooms.set(height, shell = { floor: meterUV(new BoxGeometry(14, 0.24, 16)), side: meterUV(new BoxGeometry(0.3, height, 16)), end: meterUV(new BoxGeometry(14, height, 0.3)) });
  return shell;
}

/** Floor and the four walls; `open` leaves the front wall to be built by the theme. */
function Room({ floor, floorColor, wall, wallColor, height = 5, open = false, roughness = 1 }: {
  floor: SurfaceKind; floorColor: string; wall: SurfaceKind; wallColor: string; height?: number; open?: boolean; roughness?: number;
}) {
  const shell = roomGeometry(height);
  return <group>
    <mesh geometry={shell.floor} position={[0, -0.12, 0]} receiveShadow><SurfaceMaterial kind={floor} color={floorColor} roughness={roughness}/></mesh>
    {[-7, 7].map(x => <mesh key={x} geometry={shell.side} position={[x, height / 2, 0]} receiveShadow><SurfaceMaterial kind={wall} color={wallColor}/></mesh>)}
    {(open ? [-8] : [-8, 8]).map(z => <mesh key={z} geometry={shell.end} position={[0, height / 2, z]} receiveShadow><SurfaceMaterial kind={wall} color={wallColor}/></mesh>)}
  </group>;
}

function Ceiling({ y, color }: { y: number; color: string }) {
  return <mesh position={[0, y + 0.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color={color} roughness={0.9}/></mesh>;
}

// Taller hall with steel trusses, shaded industrial lamps and safety stripes along the walls.
function Workshop({ accent }: { accent: string }) {
  return <group>
    <hemisphereLight args={['#eef3f5', '#5f5c55', 0.8]}/>
    <directionalLight position={[3, 8, 4]} intensity={1} castShadow/>
    <Room floor="concrete" floorColor="#b4b1aa" wall="concrete" wallColor="#c7c2b6" height={6.2}/>
    <Ceiling y={6.2} color="#3b3f42"/>
    {[-6, -2, 2, 6].map(z => <group key={z}>
      <Bar at={[0, 5.75, z]} size={[14, 0.22, 0.16]}/>
      {[-4.5, -1.5, 1.5, 4.5].map(x => <Bar key={x} at={[x, 5.45, z]} size={[0.08, 0.6, 0.08]} rotation={[0, 0, x > 0 ? 0.6 : -0.6]}/>)}
    </group>)}
    {[-4, 0, 4].map(z => <group key={z} position={[0, 0, z]}>
      <mesh position={[0, 5.4, 0]}><cylinderGeometry args={[0.012, 0.012, 1.6, 4]}/>{steel}</mesh>
      <mesh position={[0, 4.55, 0]}><coneGeometry args={[0.5, 0.36, 20, 1, true]}/><meshStandardMaterial color="#2f3538" metalness={0.6} roughness={0.4} side={2}/></mesh>
      <mesh position={[0, 4.45, 0]}><sphereGeometry args={[0.12, 12, 8]}/><meshStandardMaterial color="#f4f8ff" emissive="#dfe9ff" emissiveIntensity={2.2}/></mesh>
      <pointLight position={[0, 4.2, 0]} intensity={12} distance={9} color="#e8f0ff" decay={2}/>
    </group>)}
    {[-6.82, 6.82].map(x => <mesh key={x} position={[x, 0.06, 0]}><boxGeometry args={[0.04, 0.12, 16]}/><meshStandardMaterial color={accent} roughness={0.6}/></mesh>)}
    {[-6.4, 6.4].map(x => <mesh key={x} position={[x, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[0.12, 15.6]}/><meshStandardMaterial color="#e2b23c" roughness={0.8}/></mesh>)}
  </group>;
}

// Fixed pseudo-random layout of the painted stars, computed once.
const stars = new Float32Array(Array.from({ length: 260 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453, b = Math.sin(i * 78.233) * 12543.123;
  return [(a - Math.floor(a) - 0.5) * 13.4, 4.97, (b - Math.floor(b) - 0.5) * 15.4];
}).flat());

// Dark room with a painted night sky, a ring skylight and a compass rose on the floor.
function Observatory({ accent }: { accent: string }) {
  return <group>
    <hemisphereLight args={['#c9d6ff', '#2a2f3a', 0.6]}/>
    <directionalLight position={[2, 6, 5]} intensity={0.8} castShadow/>
    <Room floor="wood" floorColor="#8e7f6d" wall="stucco" wallColor="#5d667c"/>
    <Ceiling y={5} color="#141b2c"/>
    <points><bufferGeometry><bufferAttribute attach="attributes-position" args={[stars, 3]}/></bufferGeometry><pointsMaterial color="#f2f5ff" size={0.06} sizeAttenuation/></points>
    <mesh position={[0, 4.95, -1.2]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[2.4, 0.08, 10, 64]}/><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.4}/></mesh>
    <mesh position={[0, 0.006, -1.2]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.7, 2.85, 64]}/><meshStandardMaterial color="#c9a45f" metalness={0.6} roughness={0.3}/></mesh>
    {[0, Math.PI / 2].map(r => <mesh key={r} position={[0, 0.007, -1.2]} rotation={[-Math.PI / 2, 0, r]}><planeGeometry args={[0.06, 5.6]}/><meshStandardMaterial color="#c9a45f" metalness={0.6} roughness={0.3}/></mesh>)}
    {[-4.5, 0, 4.5].flatMap((z, i) => [-6.8, 6.8].map(x => <group key={`${x}${z}`} position={[x, 3.6, z + 1.2]}>
      <mesh><sphereGeometry args={[0.13, 12, 8]}/><meshStandardMaterial color="#ffe7bf" emissive="#ffcf8a" emissiveIntensity={1.8}/></mesh>
      {/* Three lights for six sconces, alternating sides, to keep the light count of the other rooms. */}
      {(x < 0) === (i % 2 === 0) && <pointLight intensity={6} distance={7} color="#ffd9a0" decay={2}/>}
    </group>))}
  </group>;
}

const gable = new Shape([new Vector2(-7, 0), new Vector2(7, 0), new Vector2(0, 2.4)]);

// Greenhouse: pale walls under a pitched glass roof on white rafters, flooded with daylight.
function Garden() {
  const rise = 2.4, half = Math.hypot(7, rise), pitch = Math.atan2(rise, 7);
  return <group>
    <hemisphereLight args={['#f4fff0', '#7a8f68', 1.2]}/>
    <directionalLight position={[3, 10, 4]} intensity={1.7} castShadow/>
    <Room floor="paving" floorColor="#d9bc9c" wall="stucco" wallColor="#e3ecdd" height={4}/>
    {[-1, 1].map(side => <group key={side} position={[side * 3.5, 4 + rise / 2, 0]} rotation={[0, 0, -side * pitch]}>
      <mesh><boxGeometry args={[half, 0.02, 16]}/>{glass}</mesh>
      {[-7.5, -5, -2.5, 0, 2.5, 5, 7.5].map(z => <Bar key={z} at={[0, -0.04, z]} size={[half, 0.08, 0.08]}><meshStandardMaterial color="#f3f3ef" roughness={0.5}/></Bar>)}
    </group>)}
    <Bar at={[0, 4 + rise, 0]} size={[0.14, 0.14, 16]}><meshStandardMaterial color="#f3f3ef" roughness={0.5}/></Bar>
    {[-8, 8].map(z => <mesh key={z} position={[0, 4, z]}><shapeGeometry args={[gable]}/>{glass}</mesh>)}
    {[-1, 1].map(side => <Bar key={side} at={[side * 6.8, 4, 0]} size={[0.2, 0.12, 16]}><meshStandardMaterial color="#f3f3ef" roughness={0.5}/></Bar>)}
  </group>;
}

// Event pavilion: warm walls under striped fabric sails and strings of festoon lights.
function Pavilion({ accent }: { accent: string }) {
  const bulbs = useMemo(() => Array.from({ length: 11 }, (_, i) => { const t = i / 10; return [-6.5 + 13 * t, 4.6 - Math.sin(t * Math.PI) * 0.6] as const; }), []);
  return <group>
    <hemisphereLight args={['#fff4e2', '#8a7454', 1]}/>
    <directionalLight position={[2, 8, 5]} intensity={1.3} castShadow/>
    <Room floor="wood" floorColor="#e6c9a2" wall="stucco" wallColor="#f2e3cc"/>
    <Ceiling y={5} color="#f6efe2"/>
    {[-6, -3, 0, 3, 6].map((z, i) => <mesh key={z} position={[0, 4.75, z]} rotation={[i % 2 ? 0.12 : -0.12, 0, 0]} receiveShadow>
      <boxGeometry args={[13.6, 0.02, 2.9]}/><meshStandardMaterial color={i % 2 ? '#fbf6ec' : accent} roughness={0.95} side={2}/>
    </mesh>)}
    {[-4.5, 1.5, 6].map(z => <group key={z} position={[0, 0, z]}>
      {bulbs.map(([x, y]) => <mesh key={x} position={[x, y, 0]}><sphereGeometry args={[0.07, 10, 6]}/><meshStandardMaterial color="#fff1cf" emissive="#ffcf7a" emissiveIntensity={2.4}/></mesh>)}
      <pointLight position={[0, 4, 0]} intensity={8} distance={8} color="#ffd59a" decay={2}/>
    </group>)}
  </group>;
}

// Office floor of a tower: polished floor, glass façade at the entrance, linear ceiling lights.
function Tower({ accent }: { accent: string }) {
  return <group>
    <hemisphereLight args={['#f2f6fa', '#7c8288', 1]}/>
    <directionalLight position={[2, 6, 9]} intensity={1.4} castShadow/>
    <Room floor="concrete" floorColor="#dcdad5" wall="stucco" wallColor="#f5f5f3" open roughness={0.35}/>
    <Ceiling y={5} color="#f7f7f5"/>
    <mesh position={[0, 2.5, 8]}><boxGeometry args={[14, 5, 0.04]}/>{glass}</mesh>
    {[-6, -4, -2, 2, 4, 6].map(x => <Bar key={x} at={[x, 2.5, 7.97]} size={[0.07, 5, 0.1]}/>)}
    {[0.02, 3.6, 4.98].map(y => <Bar key={y} at={[0, y, 7.97]} size={[14, 0.07, 0.1]}/>)}
    {[-3.5, 0, 3.5].flatMap(x => [-5, -1, 3].map(z => <mesh key={`${x}${z}`} position={[x, 4.98, z]}><boxGeometry args={[0.24, 0.03, 2.6]}/><meshStandardMaterial color="#ffffff" emissive="#f5f8ff" emissiveIntensity={2}/></mesh>))}
    {[-3.5, 3.5].map(x => <pointLight key={x} position={[x, 4.3, -1]} intensity={10} distance={10} color="#f4f7ff" decay={2}/>)}
    {[-6.83, 6.83].map(x => <mesh key={x} position={[x, 0.07, 0]}><boxGeometry args={[0.04, 0.14, 16]}/><meshStandardMaterial color={accent} roughness={0.5}/></mesh>)}
  </group>;
}

// Archive: wood wainscot, coffered ceiling beams and warm brass pendants.
function Archive() {
  const panels: { at: Vec3; size: Vec3 }[] = [
    ...[-6.83, 6.83].map(x => ({ at: [x, 1.2, 0] as Vec3, size: [0.04, 2.4, 16] as Vec3 })),
    ...[-7.82, 7.82].map(z => ({ at: [0, 1.2, z] as Vec3, size: [13.62, 2.4, 0.04] as Vec3 })),
  ];
  return <group>
    <hemisphereLight args={['#fff6e6', '#8a7a62', 0.9]}/>
    <directionalLight position={[2, 6, 5]} intensity={1.1} castShadow/>
    <Room floor="wood" floorColor="#ffffff" wall="stucco" wallColor="#efe4cf"/>
    <Ceiling y={5} color="#e9dfcb"/>
    {panels.map(({ at, size }) => <mesh key={at.join()} position={at}><boxGeometry args={size}/><SurfaceMaterial kind="wood" color="#9c7552"/></mesh>)}
    {[-3.5, 0, 3.5].map(x => <Bar key={x} at={[x, 4.85, 0]} size={[0.25, 0.3, 16]}><SurfaceMaterial kind="wood" color="#8a6643"/></Bar>)}
    {[-5.3, -2.65, 0, 2.65, 5.3].map(z => <Bar key={z} at={[0, 4.85, z]} size={[14, 0.3, 0.25]}><SurfaceMaterial kind="wood" color="#8a6643"/></Bar>)}
    {[-3, 1.5, 5].map(z => <Pendant key={z} x={0} z={z}/>)}
  </group>;
}

/** Every style without its own room falls back to the archive, the only one with a wainscot. */
export const hasWainscot = (style: BuildingStyle) => !['workshop', 'observatory', 'garden', 'pavilion', 'tower'].includes(style);

export function ProfileShell({ style, accent }: { style: BuildingStyle; accent: string }) {
  if (style === 'workshop') return <Workshop accent={accent}/>;
  if (style === 'observatory') return <Observatory accent={accent}/>;
  if (style === 'garden') return <Garden/>;
  if (style === 'pavilion') return <Pavilion accent={accent}/>;
  if (style === 'tower') return <Tower accent={accent}/>;
  return <Archive/>;
}
