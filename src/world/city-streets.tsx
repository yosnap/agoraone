import { useMemo } from 'react';
import { AdditiveBlending, BoxGeometry, PlaneGeometry } from 'three';
import type { Place } from '../data/city';
import { avenue, cityGrid, curb, street } from './city-layout';
import { useDaylight } from './daylight';
import { textures } from './textures';
import { meterUV, SurfaceMaterial } from './surfaces';
import { Hydrants, StreetLamps, type Placement } from './city-models';

const flat = [-Math.PI / 2, 0, 0] as [number, number, number];
const iron = <meshStandardMaterial color="#2f3a3b" metalness={0.7} roughness={0.35}/>;

function Bench({ at }: { at: [number, number, number] }) {
  return <group position={at}>
    {[0, 1, 2].map(i => <mesh key={i} position={[0, 0.44, -0.12 + i * 0.13]} castShadow><boxGeometry args={[1.3, 0.04, 0.1]}/><SurfaceMaterial kind="wood" color="#c79a6c"/></mesh>)}
    {[0, 1].map(i => <mesh key={i} position={[0, 0.62 + i * 0.14, -0.2]} rotation={[-0.15, 0, 0]} castShadow><boxGeometry args={[1.3, 0.1, 0.03]}/><SurfaceMaterial kind="wood" color="#c79a6c"/></mesh>)}
    {[-0.55, 0.55].map(x => <mesh key={x} position={[x, 0.22, -0.02]} castShadow><boxGeometry args={[0.05, 0.44, 0.4]}/>{iron}</mesh>)}
  </group>;
}

// Raised paving strip with a concrete curb on each edge, split where cross streets pass.
function Sidewalk({ z, from, to }: { z: number; from: number; to: number }) {
  const length = to - from;
  const slab = useMemo(() => meterUV(new BoxGeometry(length, curb, 1.14)), [length]);
  const edge = useMemo(() => meterUV(new BoxGeometry(length, curb + 0.01, 0.1)), [length]);
  return <group position={[(from + to) / 2, 0, z]}>
    <mesh geometry={slab} position={[0, curb / 2, 0]} receiveShadow><SurfaceMaterial kind="paving" color="#dfe1df"/></mesh>
    {[-0.6, 0.6].map(side => <mesh key={side} geometry={edge} position={[0, curb / 2 + 0.005, side]} receiveShadow castShadow><SurfaceMaterial kind="concrete" color="#d6d2c8"/></mesh>)}
  </group>;
}

function Road({ x, z, width, length, alongX }: { x: number; z: number; width: number; length: number; alongX: boolean }) {
  const geometry = useMemo(() => meterUV(new PlaneGeometry(alongX ? length : width, alongX ? width : length)), [width, length, alongX]);
  return <mesh geometry={geometry} rotation={flat} position={[x, alongX ? 0.012 : 0.008, z]} receiveShadow><SurfaceMaterial kind="asphalt" color="#b8b8b8"/></mesh>;
}

function LaneMarks({ avenues, span, xs }: { avenues: number[]; span: number; xs: number[] }) {
  const dashes = useMemo(() => avenues.flatMap(z => Array.from({ length: Math.floor(span / 3) }, (_, i) => [-span / 2 + 1.5 + i * 3, z] as const)), [avenues, span]);
  return <group>
    {dashes.map(([x, z]) => <mesh key={`${x}:${z}`} rotation={flat} position={[x, 0.016, z]}><planeGeometry args={[1.2, 0.1]}/><meshStandardMaterial color="#e9e4d2" roughness={0.6}/></mesh>)}
    {avenues.flatMap(z => xs.flatMap(x => Array.from({ length: 5 }, (_, i) => <mesh key={`${x}-${z}-${i}`} rotation={flat} position={[x - 1 + i * 0.5, 0.017, z]}>
      <planeGeometry args={[0.3, avenue.width - 0.2]}/><meshStandardMaterial color="#ece7d6" roughness={0.6}/></mesh>)))}
  </group>;
}

export function CityStreets({ places, extent }: { places: Place[]; extent: number }) {
  const { night } = useDaylight();
  const grid = useMemo(() => cityGrid(places, extent), [places, extent]);
  const ground = useMemo(() => meterUV(new PlaneGeometry(400, 400)), []);
  const segments = useMemo(() => {
    const cuts = [-grid.span / 2, ...grid.streets.flatMap(x => [x - street.width / 2, x + street.width / 2]).sort((a, b) => a - b), grid.span / 2];
    const list: [number, number][] = [];
    for (let i = 0; i < cuts.length; i += 2) if (cuts[i + 1] - cuts[i] > 0.2) list.push([cuts[i], cuts[i + 1]]);
    return list;
  }, [grid]);
  const lamps = useMemo<Placement[]>(() => grid.xs.flatMap(x => grid.zs.flatMap(z => [-1, 1].map(side => ({ position: [x + side * 2.7, curb, z + 3.5] as [number, number, number], rotation: Math.PI / 2 })))), [grid]);
  const hydrants = useMemo<Placement[]>(() => grid.xs.flatMap((x, i) => grid.zs.filter((_, j) => (i + j) % 2 === 0).map(z => ({ position: [x + 2.15, curb, z + 3.35] as [number, number, number], rotation: Math.PI / 2, scale: 0.9 }))), [grid]);
  return <group>
    <mesh geometry={ground} position={[0, -0.005, 0]} rotation={flat} receiveShadow><SurfaceMaterial kind="grass"/></mesh>
    {grid.avenues.map(z => <group key={`a${z}`}>
      <Road x={0} z={z} width={avenue.width} length={grid.span} alongX/>
      {[-1, 1].flatMap(side => segments.map(([from, to]) => <Sidewalk key={`${side}${from}`} z={z + side * (avenue.width / 2 + 0.65)} from={from} to={to}/>))}
    </group>)}
    {grid.streets.map(x => <Road key={`s${x}`} x={x} z={0} width={street.width} length={grid.span} alongX={false}/>)}
    <LaneMarks avenues={grid.avenues} span={grid.span} xs={grid.xs}/>
    <StreetLamps placements={lamps}/>
    <Hydrants placements={hydrants}/>
    {night > 0.05 && lamps.map(({ position: [x, , z] }) => <mesh key={`g${x}:${z}`} position={[x, 0.02, z + 0.6]} rotation={flat}><planeGeometry args={[4.6, 4.6]}/>
      <meshBasicMaterial map={textures.glow()} transparent opacity={night * 0.45} blending={AdditiveBlending} depthWrite={false}/></mesh>)}
    {grid.xs.flatMap(x => grid.zs.map(z => z + 6.9 < extent && <Bench key={`b${x}-${z}`} at={[x + 1.4, curb, z + 7]}/>))}
  </group>;
}
