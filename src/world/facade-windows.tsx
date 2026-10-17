import { Instance, Instances } from '@react-three/drei';
import { useMemo } from 'react';
import { useDaylight } from './daylight';

type Vec3 = [number, number, number];
export type Face = 'front' | 'back' | 'left' | 'right';
type Pane = { position: Vec3; rotation: Vec3; lit: boolean };

const paneW = 0.5, paneH = 0.72, spacing = 1.05;

// Window grid laid on the faces of a box volume. Glass reflects by day; at night a stable,
// pseudo-random subset glows warm as decoration (it does not reflect any real activity).
export function FacadeWindows({ center, size, faces, rows = 1, seed = 1 }: { center: Vec3; size: Vec3; faces: Face[]; rows?: number; seed?: number }) {
  const { night } = useDaylight();
  const panes = useMemo(() => {
    const list: Pane[] = [];
    faces.forEach((face, f) => {
      const alongX = face === 'front' || face === 'back';
      const width = alongX ? size[0] : size[2];
      const cols = Math.max(1, Math.floor((width - 0.5) / spacing));
      const sign = face === 'front' || face === 'right' ? 1 : -1;
      const out = (alongX ? size[2] : size[0]) / 2 + 0.015;
      const rotation: Vec3 = [0, alongX ? (sign > 0 ? 0 : Math.PI) : sign * Math.PI / 2, 0];
      const rowGap = size[1] / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const along = (c - (cols - 1) / 2) * spacing;
        const y = center[1] - size[1] / 2 + rowGap * (r + 0.55);
        const position: Vec3 = alongX ? [center[0] + along, y, center[2] + sign * out] : [center[0] + sign * out, y, center[2] + along];
        list.push({ position, rotation, lit: ((seed * 31 + f * 17 + r * 7 + c * 13) * 2654435761 >>> 0) % 100 < 58 });
      }
    });
    return list;
  }, [center, size, faces, rows, seed]);
  const h = Math.min(paneH, size[1] / rows * 0.62);
  const lit = panes.filter(p => p.lit), dark = panes.filter(p => !p.lit);
  return <group>
    <Instances limit={panes.length} castShadow={false}>
      <boxGeometry args={[paneW + 0.12, h + 0.12, 0.05]}/><meshStandardMaterial color="#e8e2d2" roughness={0.6}/>
      {panes.map((p, i) => <Instance key={i} position={p.position} rotation={p.rotation}/>)}
    </Instances>
    {[{ list: lit, glow: night * 2.4 }, { list: dark, glow: 0.02 }].map(({ list, glow }, k) => !!list.length && <Instances key={k} limit={list.length}>
      <boxGeometry args={[paneW, h, 0.06]}/>
      <meshStandardMaterial color="#27403f" metalness={0.75} roughness={0.07} emissive="#ffc77a" emissiveIntensity={glow} envMapIntensity={1.5}/>
      {list.map((p, i) => <Instance key={i} position={[p.position[0], p.position[1], p.position[2]]} rotation={p.rotation}/>)}
    </Instances>)}
  </group>;
}
