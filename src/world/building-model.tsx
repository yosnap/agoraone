import { useMemo } from 'react';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BuildingStyle } from '../data/building-style';
import { useDaylight } from './daylight';
import { FacadeWindows } from './facade-windows';
import { meterUV, SurfaceMaterial } from './surfaces';

type Vec3 = [number, number, number];
const wall = '#efe8d3', glass = '#31565a', metal = '#536e72';
// Glass reflects the local environment and glows faintly as if lit inside; metal is satin.
// Photographic stucco, roof tiles and concrete tinted by each building's palette.
// Thin wide accent slabs read as roofs; glass glows warm at night.
function Surface({ color, roof = false }: { color: string; roof?: boolean }) {
  const { night } = useDaylight();
  if (color === glass) return <meshStandardMaterial color={color} metalness={0.7} roughness={0.08} emissive="#ffd29a" emissiveIntensity={0.04 + night * 1.3} envMapIntensity={1.4}/>;
  if (color === metal) return <SurfaceMaterial kind="concrete" color="#7d9296" metalness={0.15}/>;
  return <SurfaceMaterial kind={roof ? 'roof' : 'stucco'} color={color}/>;
}
// Bevelled edges with metre-scaled UVs, so textures keep real size on every block.
function Block({ at, size, color, rotation }: { at: Vec3; size: Vec3; color: string; rotation?: Vec3 }) {
  const [w, h, d] = size;
  const geometry = useMemo(() => meterUV(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.06, Math.min(w, h, d) * 0.3))), [w, h, d]);
  const roof = color !== wall && h <= 0.3 && Math.max(w, d) > 2;
  return <mesh geometry={geometry} position={at} rotation={rotation} castShadow receiveShadow><Surface color={color} roof={roof}/></mesh>;
}
export function BuildingModel({ style, color }: { style: BuildingStyle; color: string }) {
  if (style === 'vault') return <group>
    <Block at={[0, 1.5, 0]} size={[4.4, 2.5, 3.4]} color={metal}/>
    <Block at={[0, 2.9, 0]} size={[4.8, 0.25, 3.8]} color={color}/>
    <mesh position={[0, 3.75, 0]} castShadow><octahedronGeometry args={[0.95]}/><meshStandardMaterial color={color} metalness={0.4} roughness={0.25}/></mesh>
    <Block at={[0, 1.3, 1.75]} size={[1, 1.9, 0.1]} color={color}/>
    {[-1.6, 1.6].map(x => <Block key={x} at={[x, 1.5, 1.75]} size={[0.8, 1.8, 0.1]} color={glass}/>)}
    <FacadeWindows center={[0, 1.5, 0]} size={[4.4, 2.5, 3.4]} faces={['left', 'right', 'back']} rows={2} seed={2}/>
  </group>;
  if (style === 'service') return <group>
    <Block at={[0, 1.45, 0]} size={[2.4, 2.4, 2.3]} color={metal}/>
    <Block at={[0, 1.6, 1.2]} size={[1.8, 1.1, 0.12]} color={color}/>
    <Block at={[0, 2.8, 0]} size={[2.8, 0.25, 2.7]} color={color}/>
    <Block at={[0, 3.25, 0]} size={[0.12, 0.8, 0.12]} color={metal}/>
    <mesh position={[0, 3.7, 0]} rotation={[0.3, 0, 0]} castShadow><torusGeometry args={[0.5, 0.08, 8, 24]}/><meshStandardMaterial color={color}/></mesh>
    {[-0.6, 0, 0.6].map(x => <Block key={x} at={[x, 0.65, 1.2]} size={[0.3, 0.15, 0.12]} color={color}/>)}
    <FacadeWindows center={[0, 1.45, 0]} size={[2.4, 2.4, 2.3]} faces={['left', 'right']} seed={3}/>
  </group>;
  if (style === 'observatory') return <group>
    <mesh position={[0, 1.35, 0]} castShadow receiveShadow><cylinderGeometry args={[1.9, 2.2, 2.2, 24]}/><Surface color={wall}/></mesh>
    <mesh position={[0, 2.45, 0]} castShadow><sphereGeometry args={[2.05, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]}/><meshStandardMaterial color={color} metalness={0.25} roughness={0.4}/></mesh>
    <Block at={[0, 1.3, 2.1]} size={[0.9, 1.8, 0.15]} color={glass}/>
    <Block at={[0.8, 3.65, 0.4]} size={[0.38, 0.38, 2]} rotation={[-0.5, 0.4, 0]} color={metal}/>
  </group>;
  if (style === 'workshop') return <group>
    <Block at={[0, 1.35, 0]} size={[4.8, 2.2, 3.6]} color={metal}/>
    {[-1.25, 1.25].map(x => <group key={x}><Block at={[x, 2.6, 0]} size={[2.55, 0.25, 3.9]} rotation={[0, 0, 0.18]} color={color}/><Block at={[x, 1.3, 1.84]} size={[1.9, 1.8, 0.1]} color={glass}/>
      {[0.65, 1, 1.35, 1.7].map(y => <Block key={y} at={[x, y, 1.92]} size={[1.8, 0.05, 0.06]} color={color}/>)}</group>)}
    <Block at={[-1.8, 3.1, -1]} size={[0.55, 1.3, 0.55]} color={metal}/>
    <FacadeWindows center={[0, 1.35, 0]} size={[4.8, 2.2, 3.6]} faces={['left', 'right', 'back']} seed={4}/>
  </group>;
  if (style === 'pavilion') return <group>
    <Block at={[0, 0.55, 0]} size={[4.8, 0.65, 3.6]} color={wall}/>
    {[-2, 2].flatMap(x => [-1.4, 1.4].map(z => <Block key={`${x}-${z}`} at={[x, 1.8, z]} size={[0.22, 2.5, 0.22]} color={metal}/>))}
    <mesh position={[0, 3.05, 0]} rotation={[0, Math.PI / 4, 0]} castShadow><coneGeometry args={[3.2, 1.4, 4]}/><Surface color={color} roof/></mesh>
    <Block at={[0, 1.6, -1.5]} size={[3.6, 1.4, 0.15]} color={glass}/>
    {[-0.8, 0.8].map(x => <Block key={x} at={[x, 0.98, 0.5]} size={[1.1, 0.22, 0.6]} color={color}/>)}
  </group>;
  if (style === 'garden') return <group>
    <Block at={[0, 0.6, 0]} size={[4.5, 0.7, 3.4]} color={wall}/>
    <Block at={[0, 1.7, 0]} size={[4.4, 1.5, 3.3]} color="#87b9a1"/>
    {[-1, 1].map(side => <Block key={side} at={[side * 1.1, 2.8, 0]} size={[2.5, 0.14, 3.6]} rotation={[0, 0, -side * 0.38]} color={color}/>)}
    {[-1.9, -0.65, 0.65, 1.9].map(x => <Block key={x} at={[x, 1.65, 1.7]} size={[0.12, 1.7, 0.13]} color={wall}/>)}
    {[-1.6, 1.6].map(x => <group key={x}><Block at={[x, 0.5, 2]} size={[0.8, 0.45, 0.5]} color="#af8060"/><mesh position={[x, 0.95, 2]} castShadow><icosahedronGeometry args={[0.45, 1]}/><meshStandardMaterial color="#527e53"/></mesh></group>)}
  </group>;
  if (style === 'tower') return <group>
    <Block at={[0, 1.9, 0]} size={[3.2, 3.3, 3]} color={glass}/>
    {[0.6, 1.6, 2.6, 3.6].map(y => <Block key={y} at={[0, y, 0]} size={[3.5, 0.2, 3.3]} color={wall}/>)}
    <Block at={[0.3, 4, -0.25]} size={[2.1, 0.7, 2]} color={color}/>
    {[-1.4, 0, 1.4].map(x => <Block key={x} at={[x, 2.1, 1.53]} size={[0.09, 3.2, 0.12]} color={color}/>)}
  </group>;
  if (style === 'archive') return <group>
    {[0, 1, 2].map(level => <Block key={level} at={[0, 0.8 + level * 0.95, 0]} size={[4.6 - level * 0.7, 0.8, 3.4 - level * 0.45]} color={level % 2 ? color : wall}/>)}
    <Block at={[0, 1, 1.75]} size={[1.1, 1.5, 0.12]} color={glass}/>
    <Block at={[0, 3.35, 0]} size={[1.6, 0.4, 1.4]} color={metal}/>
    {[0, 1, 2].map(level => <FacadeWindows key={level} center={[0, 0.8 + level * 0.95, 0]} size={[4.6 - level * 0.7, 0.8, 3.4 - level * 0.45]} faces={level ? ['left', 'right', 'back'] : ['left', 'right']} seed={5 + level}/>)}
  </group>;
  return <group>
    <Block at={[0, 1.5, 0]} size={[4.8, 2.5, 3.6]} color={wall}/>
    <Block at={[0, 2.85, 0]} size={[5.2, 0.25, 4]} color={color}/>
    <mesh position={[0, 3.3, 0]} rotation={[0, Math.PI / 4, 0]} castShadow><coneGeometry args={[2.5, 0.85, 4]}/><Surface color={color} roof/></mesh>
    <Block at={[0, 1.45, 1.85]} size={[3.9, 1.8, 0.1]} color={glass}/>
    {[-1.9, -0.65, 0.65, 1.9].map(x => <Block key={x} at={[x, 1.4, 2]} size={[0.22, 2.4, 0.3]} color={wall}/>)}
    <Block at={[0, 2.65, 2]} size={[4.4, 0.3, 0.65]} color={color}/>
    <FacadeWindows center={[0, 1.5, 0]} size={[4.8, 2.5, 3.6]} faces={['left', 'right', 'back']} seed={1}/>
  </group>;
}
