import { Suspense, useMemo } from 'react';
import { ModelInstances, type ModelKey, type Placement } from './city-models';

// Furniture and props for the interiors: CC0 Poly Haven models in real metres (see
// docs/recursos-visuales.md). Decoration only: nothing here reflects or simulates activity.
export type Item = { model: ModelKey; at: [number, number, number]; turn?: number; scale?: number };

/** One instanced draw per model part, however many copies; loads apart so the room shows at once. */
export function Furniture({ items }: { items: Item[] }) {
  const groups = useMemo(() => {
    const byModel = new Map<ModelKey, Placement[]>();
    for (const { model, at, turn, scale } of items) {
      const list = byModel.get(model) ?? [];
      list.push({ position: at, rotation: turn, scale });
      byModel.set(model, list);
    }
    return [...byModel];
  }, [items]);
  return <Suspense fallback={null}>{groups.map(([model, placements]) => <ModelInstances key={model} model={model} placements={placements}/>)}</Suspense>;
}

/** A flat rug with a border, slightly above the floor. */
export function Rug({ at, size, color, border, turn = 0 }: { at: [number, number]; size: [number, number]; color: string; border: string; turn?: number }) {
  return <group position={[at[0], 0, at[1]]} rotation={[0, turn, 0]}>
    <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[size[0] + 0.2, size[1] + 0.2]}/><meshStandardMaterial color={border} roughness={1}/></mesh>
    <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={size}/><meshStandardMaterial color={color} roughness={1}/></mesh>
  </group>;
}

/** A warm light source without geometry, for lamps whose model has no emitter of its own. */
export function Glow({ at, color = '#ffd59a', intensity = 5, distance = 5 }: { at: [number, number, number]; color?: string; intensity?: number; distance?: number }) {
  return <pointLight position={at} intensity={intensity} distance={distance} color={color} decay={2}/>;
}
