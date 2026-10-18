import { useMemo } from 'react';
import { BoxGeometry } from 'three';
import type { VaultShelf } from '../data/use-vault-notes';
import { WorldLabel } from './world-label';
import { Pendant } from './library-interior';
import { meterUV, SurfaceMaterial } from './surfaces';
import { Shelf } from './vault-shelf';

// A reading room for the vault: one shelf per top-level folder (real structure, read-only) whose
// books are its notes, and a reading table in the middle. Only decoration besides the shelves.
const slots = [-5.8, -3.2, -0.6, 2, 4.6].flatMap(z => [-5.4, 5.4].map(x => ({ x, z })));
export const vaultObstacles = [...slots.map(({ x, z }) => ({ x, z, halfX: 0.8, halfZ: 1.5 })), { x: 0, z: -1.5, halfX: 2.1, halfZ: 0.9 }];

function Plant({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, 0.3, 0]} castShadow><cylinderGeometry args={[0.32, 0.24, 0.6, 16]}/><SurfaceMaterial kind="concrete" color="#b07a5a"/></mesh>
    {[[0, 0.95, 0, 0.42], [0.2, 1.3, 0.1, 0.3], [-0.18, 1.2, -0.12, 0.32]].map(([px, py, pz, r], i) =>
      <mesh key={i} position={[px, py, pz]} castShadow><icosahedronGeometry args={[r, 1]}/><meshStandardMaterial color={i ? '#557a4a' : '#47693f'} roughness={0.9} flatShading/></mesh>)}
  </group>;
}

function Armchair({ x, turn }: { x: number; turn: number }) {
  return <group position={[x, 0, -1.5]} rotation={[0, turn, 0]}>
    <mesh position={[0, 0.25, 0]} castShadow><boxGeometry args={[0.8, 0.5, 0.75]}/><meshStandardMaterial color="#7a3f4a" roughness={0.85}/></mesh>
    <mesh position={[0, 0.75, 0.32]} castShadow><boxGeometry args={[0.8, 0.6, 0.15]}/><meshStandardMaterial color="#6d3640" roughness={0.85}/></mesh>
    {[-0.36, 0.36].map(side => <mesh key={side} position={[side, 0.55, 0]}><boxGeometry args={[0.1, 0.2, 0.75]}/><meshStandardMaterial color="#6d3640"/></mesh>)}
  </group>;
}

function ReadingTable({ onOpen }: { onOpen: () => void }) {
  return <group position={[0, 0, -1.5]}>
    <mesh position={[0, 0.82, 0]} castShadow receiveShadow><boxGeometry args={[2.4, 0.08, 1.2]}/><SurfaceMaterial kind="wood" color="#6b4a30"/></mesh>
    {[[-1.05, -0.5], [1.05, -0.5], [-1.05, 0.5], [1.05, 0.5]].map(([lx, lz]) => <mesh key={`${lx}${lz}`} position={[lx, 0.4, lz]}><boxGeometry args={[0.1, 0.8, 0.1]}/><SurfaceMaterial kind="wood" color="#4a3221"/></mesh>)}
    <group position={[-0.1, 0.88, 0.05]} onClick={event => { event.stopPropagation(); onOpen(); }}>
      {[-1, 1].map(side => <mesh key={side} position={[side * 0.24, 0.03, 0]} rotation={[0, 0, side * -0.12]} castShadow>
        <boxGeometry args={[0.46, 0.04, 0.62]}/><meshStandardMaterial color="#f4ead2" roughness={0.9}/></mesh>)}
      <mesh position={[0, 0.005, 0]}><boxGeometry args={[1, 0.02, 0.66]}/><meshStandardMaterial color="#5c3a2a"/></mesh>
    </group>
    <group position={[0.85, 0.86, -0.3]}>
      <mesh position={[0, 0.02, 0]}><cylinderGeometry args={[0.12, 0.14, 0.04, 16]}/><meshStandardMaterial color="#2f3a32" metalness={0.5} roughness={0.4}/></mesh>
      <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[0.015, 0.015, 0.45, 6]}/><meshStandardMaterial color="#2f3a32"/></mesh>
      <mesh position={[0, 0.5, 0]}><coneGeometry args={[0.16, 0.18, 16, 1, true]}/><meshStandardMaterial color="#3d6b4e" side={2}/></mesh>
      <mesh position={[0, 0.44, 0]}><sphereGeometry args={[0.05, 10, 8]}/><meshStandardMaterial color="#fff3d1" emissive="#ffcf7a" emissiveIntensity={2.5}/></mesh>
      <pointLight position={[0, 0.4, 0]} intensity={4} distance={3.5} color="#ffd59a" decay={2}/>
    </group>
    <WorldLabel position={[-0.1, 1.45, 0]} distanceFactor={9}><button className="place-label" onClick={onOpen}>Mesa de lectura · todas las carpetas</button></WorldLabel>
  </group>;
}

export function VaultInterior({ name, shelves, onOpen, onBook, onExit }: { name: string; shelves: VaultShelf[]; onOpen: (folder: string | null) => void; onBook: (id: string) => void; onExit: () => void }) {
  const floor = useMemo(() => meterUV(new BoxGeometry(14, 0.24, 16)), []);
  return <group>
    <hemisphereLight args={['#fff1dc', '#6f5a7a', 0.85]}/>
    <directionalLight position={[2, 6, 4]} intensity={1.1} color="#ffe9c9" castShadow/>
    <mesh geometry={floor} position={[0, -0.12, 0]} receiveShadow><SurfaceMaterial kind="wood" color="#b89674" roughness={0.75}/></mesh>
    <mesh position={[0, 0.011, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[5.4, 12.5]}/><meshStandardMaterial color="#5b2f45" roughness={1}/></mesh>
    <mesh position={[0, 0.013, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.9, 2.05, 48]}/><meshStandardMaterial color="#c9a45f"/></mesh>
    <mesh position={[0, 5.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color="#efe6d6" roughness={0.9}/></mesh>
    {[-6, -3, 0, 3, 6].map(z => <mesh key={z} position={[0, 4.9, z]}><boxGeometry args={[14, 0.22, 0.3]}/><SurfaceMaterial kind="wood" color="#5d4632"/></mesh>)}
    {[-7, 7].map(x => <group key={x}>
      <mesh position={[x, 2.5, 0]}><boxGeometry args={[0.3, 5, 16]}/><meshStandardMaterial color="#6e5f86" roughness={0.95}/></mesh>
      <mesh position={[x * 0.975, 0.6, 0]}><boxGeometry args={[0.08, 1.2, 16]}/><SurfaceMaterial kind="wood" color="#4f3a2a"/></mesh>
    </group>)}
    <mesh position={[0, 2.5, -8]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#5a4c72" roughness={0.95}/></mesh>
    <mesh position={[0, 2.5, 8]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#5a4c72" roughness={0.95}/></mesh>
    {[-4.6, 4.6].map(x => <group key={x} position={[x, 2.7, -7.82]}>
      <mesh><boxGeometry args={[1.6, 3, 0.06]}/><meshStandardMaterial color="#cfe0ef" emissive="#9fc2e6" emissiveIntensity={0.55}/></mesh>
      <mesh position={[0, 0, 0.04]}><boxGeometry args={[0.06, 3, 0.04]}/><meshStandardMaterial color="#3b2c22"/></mesh>
      <mesh position={[0, 0.3, 0.04]}><boxGeometry args={[1.6, 0.06, 0.04]}/><meshStandardMaterial color="#3b2c22"/></mesh>
    </group>)}
    {[-3, 1.5, 5].map(z => <Pendant key={z} x={0} z={z}/>)}
    <ReadingTable onOpen={() => onOpen(null)}/>
    <Armchair x={-1.75} turn={Math.PI / 2}/>
    <Armchair x={1.75} turn={-Math.PI / 2}/>
    {[[-6.3, -7.3], [6.3, -7.3], [-6.3, 7.2], [6.3, 7.2]].map(([px, pz]) => <Plant key={`${px}${pz}`} x={px} z={pz}/>)}
    {shelves.slice(0, slots.length).map((shelf, i) => <Shelf key={shelf.folder} {...slots[i]} shelf={shelf} onShelf={() => onOpen(shelf.folder)} onBook={onBook}/>)}
    {shelves.length > slots.length && <WorldLabel position={[0, 1.6, -6]} distanceFactor={10}><button className="place-label" onClick={() => onOpen(null)}>{shelves.length - slots.length} carpetas más · ver todas</button></WorldLabel>}
    {!shelves.length && <WorldLabel position={[0, 1.8, -4]} distanceFactor={10}><span className="place-label">Vault sin notas Markdown legibles</span></WorldLabel>}
    <mesh position={[0, 3.6, -7.8]}><boxGeometry args={[5, 1.1, 0.1]}/><SurfaceMaterial kind="wood" color="#3b2c22"/></mesh>
    <WorldLabel position={[0, 3.6, -7.65]} distanceFactor={12}><button className="place-label" onClick={() => onOpen(null)}>OBSIDIAN · {name.toUpperCase()}</button></WorldLabel>
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.2, 3.4, 0.15]}/><SurfaceMaterial kind="wood" color="#5d4632"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
  </group>;
}
