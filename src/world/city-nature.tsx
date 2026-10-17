import { useMemo } from 'react';
import type { Place } from '../data/city';
import { cityGrid, curb } from './city-layout';
import { ModelInstances, type Placement } from './city-models';

// Decorative olive trees (CC0 scans); positions avoid plots, roads and the walking sidewalk.
export function CityNature({ places, extent }: { places: Place[]; extent: number }) {
  const { street, park, pits } = useMemo(() => {
    const grid = cityGrid(places, extent);
    const street: Placement[] = [], park: Placement[] = [];
    const add = (list: Placement[], x: number, z: number, y: number, size: number) => {
      const seed = Math.abs(Math.round(x * 7 + z * 13));
      list.push({ position: [x, y, z], rotation: seed % 6, scale: size * (0.85 + (seed % 5) * 0.07) });
    };
    grid.xs.forEach(x => grid.zs.forEach(z => { if (z + 6.95 < extent - 0.3) add(street, x - 2.4, z + 6.95, curb, 0.62); }));
    const edge = extent - 1.2;
    const clear = (value: number, roads: number[], gap: number) => roads.every(road => Math.abs(value - road) > gap);
    for (let v = -edge; v <= edge; v += 3.6) {
      if (clear(v, grid.avenues, 2.4)) [-edge, edge, -edge - 4, edge + 4].forEach(x => add(park, x, v + (x > 0 ? 0.9 : 0), 0, 0.85));
      if (clear(v, grid.streets, 1.8) && Math.abs(v) < edge - 1) [-edge, -edge - 4].forEach(z => add(park, v + (z < -edge ? 1.4 : 0), z, 0, 0.85));
    }
    return { street, park, pits: street.map(p => p.position) };
  }, [places, extent]);
  const [plain, twisted] = useMemo(() => [[...street, ...park.filter((_, i) => i % 2)], park.filter((_, i) => !(i % 2))], [street, park]);
  return <group>
    <ModelInstances model="olive" placements={plain}/>
    <ModelInstances model="oliveTwisted" placements={twisted}/>
    {pits.map(([x, , z]) => <mesh key={`pit${x}:${z}`} position={[x, curb + 0.003, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.9, 0.9]}/><meshStandardMaterial color="#4a3b2c" roughness={1}/></mesh>)}
  </group>;
}
