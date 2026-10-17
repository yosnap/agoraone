import { useState } from 'react';
import { WorldLabel } from './world-label';

const terminalPositions = Array.from({ length: 8 }, (_, index) => ({ x: index % 2 ? 5.5 : -5.5, z: -5 + Math.floor(index / 2) * 2.8 }));
export const integrationObstacles = terminalPositions.map(({ x, z }) => ({ x, z, halfX: 1.15, halfZ: 1.1 }));

export function IntegrationsInterior({ services, onSelect, onExit }: {
  services: { id: string; name: string }[]; onSelect: (id: string) => void; onExit: () => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(services.length / 8));
  const current = Math.min(page, pages - 1);
  return <group>
    <hemisphereLight args={["#d8f4f6", "#4a6873", 1]}/><pointLight position={[0, 4.5, 1]} intensity={95} color="#b3e9ed"/>
    <directionalLight position={[0, 5, 6]} intensity={1.5}/>
    <mesh position={[0, -0.12, 0]} receiveShadow><boxGeometry args={[14, 0.24, 16]}/><meshStandardMaterial color="#283d45" metalness={0.35} roughness={0.45}/></mesh>
    <mesh position={[0, 5.1, 0]}><boxGeometry args={[14, 0.2, 16]}/><meshStandardMaterial color="#3b5964" roughness={0.7}/></mesh>
    {[-7, 7].map(x => <mesh key={x} position={[x, 2.5, 0]}><boxGeometry args={[0.3, 5, 16]}/><meshStandardMaterial color="#18343d"/></mesh>)}
    {[-8, 8].map(z => <mesh key={z} position={[0, 2.5, z]}><boxGeometry args={[14, 5, 0.3]}/><meshStandardMaterial color="#18343d"/></mesh>)}
    {[-3.5, 3.5].map(x => <mesh key={x} position={[x, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[0.08, 15]}/><meshBasicMaterial color="#8cd1d5"/></mesh>)}
    {[-4, 0, 4].map(z => <mesh key={z} position={[0, 4.95, z]}><boxGeometry args={[8, 0.05, 0.16]}/><meshBasicMaterial color="#d0f5eb"/></mesh>)}
    <mesh position={[0, 2.8, -7.8]}><boxGeometry args={[8, 2.2, 0.1]}/><meshStandardMaterial color="#0a202a"/></mesh>
    <WorldLabel position={[0, 2.8, -7.6]} distanceFactor={12}><span className="place-label">CENTRO DE INTEGRACIONES · MCP</span></WorldLabel>
    {services.slice(current * 8, current * 8 + 8).map((service, index) => {
      const { x, z } = terminalPositions[index];
      return <group key={service.id} position={[x, 0, z]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]} onClick={event => { event.stopPropagation(); onSelect(service.id); }}>
        <mesh position={[0, 1.15, 0]} castShadow><boxGeometry args={[1.65, 2.3, 0.85]}/><meshStandardMaterial color="#49646d" metalness={0.55} roughness={0.35}/></mesh>
        <mesh position={[0, 1.6, 0.46]}><boxGeometry args={[1.35, 0.85, 0.08]}/><meshStandardMaterial color="#6bc0cb" emissive="#235963" emissiveIntensity={0.5}/></mesh>
        <mesh position={[0, 0.95, 0.65]} rotation={[0.3, 0, 0]}><boxGeometry args={[1.5, 0.1, 0.7]}/><meshStandardMaterial color="#1f3843"/></mesh>
        <WorldLabel position={[0, 2.65, 0.5]} distanceFactor={9}><button className="place-label" onClick={() => onSelect(service.id)}>MCP · {service.name}</button></WorldLabel>
      </group>;
    })}
    {pages > 1 && <WorldLabel position={[0, 1.6, -6]} distanceFactor={10}><div className="place-label"><button onClick={() => setPage((current + pages - 1) % pages)}>Anterior</button> {current + 1}/{pages} <button onClick={() => setPage((current + 1) % pages)}>Siguiente</button></div></WorldLabel>}
    <mesh position={[0, 1.7, 7.8]}><boxGeometry args={[2.4, 3.4, 0.1]}/><meshStandardMaterial color="#486b73"/></mesh>
    <WorldLabel position={[0, 2, 7.5]} distanceFactor={9}><button className="place-label" onClick={onExit}>Salir a la ciudad</button></WorldLabel>
  </group>;
}
