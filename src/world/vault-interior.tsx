import { useMemo } from 'react';
import { BoxGeometry } from 'three';
import { WorldLabel } from './world-label';
import { Pendant } from './library-interior';
import { meterUV, SurfaceMaterial } from './surfaces';

// One shelf per top-level folder of the vault (real structure, read-only). Book counts follow
// the number of notes; titles and contents are only read in the panel, never in the scene.
const slots = [-5.8, -3.2, -0.6, 2, 4.6].flatMap(z => [-5.4, 5.4].map(x => ({ x, z })));
export const vaultObstacles = slots.map(({ x, z }) => ({ x, z, halfX: 0.8, halfZ: 1.5 }));
const bookColors = ['#8c79b8', '#b5a1dc', '#6d6290', '#c9bfe0', '#56506f'];

export type VaultShelf = { folder: string; notes: number };

function Shelf({ x, z, shelf, onOpen }: { x: number; z: number; shelf: VaultShelf; onOpen: () => void }) {
  const books = Math.min(36, Math.max(1, shelf.notes));
  return <group position={[x, 0, z]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]} onClick={event => { event.stopPropagation(); onOpen(); }}>
    <mesh position={[0, 1.6, 0]} castShadow receiveShadow><boxGeometry args={[2.6, 3.2, 0.6]}/><SurfaceMaterial kind="wood" color="#6b5640"/></mesh>
    {[0.5, 1.3, 2.1, 2.9].map((y, row) => <group key={y}>
      <mesh position={[0, y - 0.28, 0.32]}><boxGeometry args={[2.62, 0.06, 0.4]}/><meshStandardMaterial color="#a88b60"/></mesh>
      {Array.from({ length: Math.min(9, Math.max(0, books - row * 9)) }, (_, index) => <mesh key={index} position={[-1.05 + index * 0.26, y, 0.35]} castShadow>
        <boxGeometry args={[0.18, 0.4 + (index % 3) * 0.08, 0.3]}/><meshStandardMaterial color={bookColors[(index + row) % bookColors.length]}/>
      </mesh>)}
    </group>)}
    <WorldLabel position={[0, 3.6, 0.4]} distanceFactor={10}><button className="place-label" onClick={onOpen}>{shelf.folder || 'Notas sueltas'} · {shelf.notes} {shelf.notes === 1 ? 'nota' : 'notas'}</button></WorldLabel>
  </group>;
}

export function VaultInterior({ name, shelves, onOpen, onExit }: { name: string; shelves: VaultShelf[]; onOpen: (folder: string | null) => void; onExit: () => void }) {
  const floor = useMemo(() => meterUV(new BoxGeometry(14, 0.24, 16)), []);
  return <group>
    <hemisphereLight args={['#f1ecff', '#8f86a8', 0.95]}/>
    <directionalLight position={[1, 6, 4]} intensity={1.3} castShadow/>
    <mesh geometry={floor} position={[0, -0.12, 0]} receiveShadow><SurfaceMaterial kind="wood" color="#d9cfe6" roughness={0.8}/></mesh>
    <mesh position={[0, 5.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color="#e7e2ef" roughness={0.9}/></mesh>
    {[-7, 7].map(x => <mesh key={x} position={[x, 2.5, 0]}><boxGeometry args={[0.3, 5, 16]}/><meshStandardMaterial color="#3d3654"/></mesh>)}
    {[-8, 8].map(z => <mesh key={z} position={[0, 2.5, z]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#2f2a44"/></mesh>)}
    {[-3, 1.5, 5].map(z => <Pendant key={z} x={0} z={z}/>)}
    {shelves.slice(0, slots.length).map((shelf, i) => <Shelf key={shelf.folder} {...slots[i]} shelf={shelf} onOpen={() => onOpen(shelf.folder)}/>)}
    {shelves.length > slots.length && <WorldLabel position={[0, 1.6, -6]} distanceFactor={10}><button className="place-label" onClick={() => onOpen(null)}>{shelves.length - slots.length} carpetas más · ver todas</button></WorldLabel>}
    {!shelves.length && <WorldLabel position={[0, 1.8, -4]} distanceFactor={10}><span className="place-label">Vault sin notas Markdown legibles</span></WorldLabel>}
    <mesh position={[0, 2.8, -7.8]}><boxGeometry args={[6, 1.9, 0.1]}/><meshStandardMaterial color="#1d1a2b"/></mesh>
    <WorldLabel position={[0, 2.8, -7.65]} distanceFactor={12}><button className="place-label" onClick={() => onOpen(null)}>OBSIDIAN · {name.toUpperCase()}</button></WorldLabel>
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.2, 3.4, 0.15]}/><meshStandardMaterial color="#8c79b8"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
  </group>;
}
