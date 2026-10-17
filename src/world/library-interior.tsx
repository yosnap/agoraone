import { useMemo } from 'react';
import { WorldLabel } from './world-label';
import { StandingPerson } from './standing-person';
import { BoxGeometry } from 'three';
import { meterUV, SurfaceMaterial } from './surfaces';

export const libraryObstacles = [
  { x: 0, z: -1.5, halfX: 2.1, halfZ: 1.2 },
  { x: -5.5, z: -3.5, halfX: 0.9, halfZ: 2.5 },
  { x: 5.5, z: -3.5, halfX: 0.9, halfZ: 2.5 },
];
const bookColors = ['#b6935a', '#718e83', '#9e6052', '#c6bca1', '#5c777b'];

export function Pendant({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, 4.55, 0]}><cylinderGeometry args={[0.01, 0.01, 1, 4]}/><meshStandardMaterial color="#2c2a24"/></mesh>
    <mesh position={[0, 3.95, 0]}><coneGeometry args={[0.38, 0.32, 20, 1, true]}/><meshStandardMaterial color="#c9a45f" metalness={0.6} roughness={0.3} side={2}/></mesh>
    <mesh position={[0, 3.85, 0]}><sphereGeometry args={[0.1, 12, 8]}/><meshStandardMaterial color="#fff3d1" emissive="#ffcf7a" emissiveIntensity={2}/></mesh>
    <pointLight position={[0, 3.6, 0]} intensity={9} distance={7} color="#ffd59a" decay={2}/>
  </group>;
}

function Bookshelf({ x, onBrowse }: { x: number; onBrowse: () => void }) {
  return <group position={[x, 0, -3.5]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}>
    <mesh position={[0, 1.8, 0]} castShadow><boxGeometry args={[4, 3.6, 0.65]}/><meshStandardMaterial color="#554839"/></mesh>
    {[0.6, 1.5, 2.4].map((y, row) => <group key={y}>
      <mesh position={[0, y - 0.3, 0.45]}><boxGeometry args={[4.1, 0.08, 0.85]}/><meshStandardMaterial color="#b69a70"/></mesh>
      {Array.from({ length: 12 }, (_, index) => <mesh key={index} position={[-1.75 + index * 0.31, y, 0.5]} castShadow>
        <boxGeometry args={[0.22, 0.45 + (index % 3) * 0.1, 0.35]}/><meshStandardMaterial color={bookColors[(index + row) % bookColors.length]}/>
      </mesh>)}
    </group>)}
    <WorldLabel position={[0, 3.9, 0.4]} distanceFactor={10}>
      <button className="place-label" onClick={onBrowse}>Abrir estantería · documentos</button>
    </WorldLabel>
  </group>;
}

export function LibraryInterior({ onBrowse, onChat, onExit, seed }: { onBrowse: () => void; onChat: () => void; onExit: () => void; seed: number }) {
  const floor = useMemo(() => meterUV(new BoxGeometry(14, 0.24, 16)), []);
  return <group>
    <hemisphereLight args={['#fff4dc', '#b49a74', 1]}/>
    <pointLight position={[0, 4.5, 1]} intensity={65} color="#ffe2ac" decay={2}/>
    <directionalLight position={[1, 6, 4]} intensity={1.5}/>
    <mesh geometry={floor} position={[0, -0.12, 0]} receiveShadow><SurfaceMaterial kind="wood" roughness={0.8}/></mesh>
    <mesh position={[0, 5.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color="#e6dcc4" roughness={0.9}/></mesh>
    <mesh position={[0, 2.5, -8]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#244a40"/></mesh>
    {[-7, 7].map(x => <mesh key={x} position={[x, 2.5, 0]}><boxGeometry args={[0.3, 5, 16]}/><meshStandardMaterial color="#34564b"/></mesh>)}
    <mesh position={[0, 2.5, 8]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#244a40"/></mesh>
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.2, 3.4, 0.15]}/><meshStandardMaterial color="#bba278"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
    <mesh position={[0, 0.015, 0.5]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[5, 10]}/><meshStandardMaterial color="#617b69"/></mesh>
    {[-3, 1.5, 5].map(z => <Pendant key={z} x={0} z={z}/>)}
    {[1, 4.6].map(z => [-6.84, 6.84].map(x => <group key={`${x}${z}`} position={[x, 2.6, z]}>
      <mesh><boxGeometry args={[0.04, 2.2, 1.6]}/><meshStandardMaterial color="#e9f2ec" emissive="#dff1ff" emissiveIntensity={0.55}/></mesh>
      <mesh><boxGeometry args={[0.08, 2.3, 0.08]}/><meshStandardMaterial color="#3a3226"/></mesh>
    </group>))}
    {[-6.83, 6.83].map(x => <mesh key={x} position={[x, 0.55, 3]}><boxGeometry args={[0.06, 1.1, 9.6]}/><meshStandardMaterial color="#5b4630" roughness={0.6}/></mesh>)}
    <Bookshelf x={-5.5} onBrowse={onBrowse}/><Bookshelf x={5.5} onBrowse={onBrowse}/>
    <group position={[0, 0, -1.5]}>
      <mesh position={[0, 1, 0]} castShadow><boxGeometry args={[3.6, 0.18, 1.5]}/><meshStandardMaterial color="#a88b60"/></mesh>
      {[-1.4, 1.4].map(x => <mesh key={x} position={[x, 0.5, 0]}><boxGeometry args={[0.2, 1, 1.1]}/><meshStandardMaterial color="#55483a"/></mesh>)}
      <mesh position={[0, 1.16, 0]} onClick={onBrowse}><boxGeometry args={[0.9, 0.12, 0.65]}/><meshStandardMaterial color="#dcc78a"/></mesh>
      <WorldLabel position={[0, 1.9, 0]} distanceFactor={9}><button className="character-label" onClick={onChat}>Conversar con Luma</button></WorldLabel>
    </group>
    <StandingPerson seed={seed} color="#e7bd6a" position={[0, 0, -3.1]} onClick={onChat}/>
    <mesh position={[0, 2.8, -7.8]}><boxGeometry args={[5, 1.9, 0.1]}/><meshStandardMaterial color="#152e2b"/></mesh>
    <WorldLabel position={[0, 2.8, -7.65]} distanceFactor={12}><span className="place-label">BIBLIOTECA / ARCHIVO DE IDEAS</span></WorldLabel>
  </group>;
}
