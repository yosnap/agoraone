import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { WorldLabel } from '../world/world-label';
import { BufferGeometry, Color, Float32BufferAttribute, InstancedMesh, Object3D } from 'three';
import type { BrainGraph } from '../api/core';

import { useResolvedTheme } from '../shell/theme';

// What CSS cannot reach: the scene's own colours per theme.
const scene = {
  light: { background: '#f1f2ea', dim: new Color('#c9cfc6'), link: '#4f6f66', near: '#b08a3e', other: '#8a7aa8' },
  dark: { background: '#08121c', dim: new Color('#233646'), link: '#5fd3e6', near: '#d9a94a', other: '#9d8fd0' },
};
const holder = new Object3D();

/** One sphere per note. Lives inside the Canvas: its layout effect must run in the three.js tree, after the
 * mesh exists (an effect of the component holding the Canvas would run before it). */
function Nodes({ graph, positions, lit, colors, typeColors, dim, ...events }: {
  graph: BrainGraph; positions: Float32Array; lit: Set<string> | null; colors: Map<string, string>; typeColors: Partial<Record<string, string>>; dim: Color;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => void; onPointerOut: () => void; onClick: (event: ThreeEvent<MouseEvent>) => void;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const instances = mesh.current;
    if (!instances) return;
    graph.nodes.forEach((node, position) => {
      const size = node.type === 'note' ? 0.32 + Math.sqrt(node.degree) * 0.13 : 0.5 + Math.sqrt(node.degree) * 0.16;
      holder.position.set(positions[position * 3], positions[position * 3 + 1], positions[position * 3 + 2]);
      holder.scale.setScalar(lit?.has(node.id) ? size * 1.6 : size);
      holder.updateMatrix();
      instances.setMatrixAt(position, holder.matrix);
      instances.setColorAt(position, lit && !lit.has(node.id) ? dim : new Color(node.type === 'note' ? colors.get((node.folder ?? '').split('/')[0]) ?? '#9a93a8'
        : node.type === 'folder' ? colors.get(node.id.split('/')[1] ?? '') ?? '#9a93a8' : typeColors[node.type] ?? '#9a93a8'));
    });
    instances.instanceMatrix.needsUpdate = true;
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
    instances.computeBoundingSphere();
  }, [graph, positions, lit, colors, typeColors, dim]);
  return <instancedMesh ref={mesh} args={[undefined, undefined, graph.nodes.length]} {...events}>
    <sphereGeometry args={[1, 18, 14]}/>
    <meshStandardMaterial roughness={0.55}/>
  </instancedMesh>;
}

/** The graph in 3D: one sphere per note (size by connections, colour by top folder), solid lines for real
 * links and faint ones for closeness in meaning. It only turns slowly by itself, and not at all when the
 * system asks to reduce motion. */
export default function BrainGraphScene({ graph, positions, lit, colors, typeColors, reading, onPick, still }: {
  graph: BrainGraph; positions: Float32Array; lit: Set<string> | null; colors: Map<string, string>; typeColors: Partial<Record<string, string>>;
  reading: string[] | null; onPick: (index: number) => void; still: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const theme = scene[useResolvedTheme()];
  const radius = useMemo(() => {
    let far = 10;
    for (let index = 0; index < positions.length; index += 3) far = Math.max(far, Math.hypot(positions[index], positions[index + 1], positions[index + 2]));
    return far;
  }, [positions]);
  const index = useMemo(() => new Map(graph.nodes.map((node, position) => [node.id, position])), [graph]);
  const lines = useMemo(() => {
    const make = (...kinds: string[]) => {
      const points: number[] = [];
      for (const edge of graph.edges) {
        if (!kinds.includes(edge.kind)) continue;
        const a = index.get(edge.a), b = index.get(edge.b);
        if (a === undefined || b === undefined) continue;
        points.push(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2], positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      return geometry;
    };
    return { link: make('link'), near: make('near'), other: make('mention', 'in') };
  }, [graph, index, positions]);
  const labelled = useMemo(() => {
    const chosen = new Set<number>();
    if (hover !== null) chosen.add(hover);
    // The ten most connected entities, tags and folders keep their name on screen while nothing is lit.
    if (!lit) graph.nodes.map((node, position) => ({ node, position })).filter(item => item.node.type !== 'note')
      .sort((a, b) => b.node.degree - a.node.degree).slice(0, 10).forEach(item => chosen.add(item.position));
    if (lit && lit.size <= 12) for (const id of lit) { const position = index.get(id); if (position !== undefined) chosen.add(position); }
    for (const id of reading ?? []) { const position = index.get(id); if (position !== undefined) chosen.add(position); }
    return [...chosen];
  }, [hover, lit, index, reading, graph]);
  const point = (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); if (event.instanceId !== undefined) setHover(event.instanceId); };
  return <Canvas camera={{ position: [0, radius * 0.4, radius * 2.1], fov: 45, near: 0.1, far: radius * 10 }} dpr={[1, 1.7]}
    onPointerMissed={() => setHover(null)} aria-label="Grafo del cerebro">
    <color attach="background" args={[theme.background]}/>
    <ambientLight intensity={1.6}/>
    <directionalLight position={[radius, radius, radius]} intensity={1.4}/>
    <Nodes key={graph.nodes.length} graph={graph} positions={positions} lit={lit} colors={colors} typeColors={typeColors} dim={theme.dim}
      onPointerMove={point} onPointerOut={() => setHover(null)}
      onClick={event => { event.stopPropagation(); if (event.instanceId !== undefined) onPick(event.instanceId); }}/>
    <lineSegments geometry={lines.link}><lineBasicMaterial color={theme.link} transparent opacity={lit ? 0.18 : 0.45}/></lineSegments>
    <lineSegments geometry={lines.other}><lineBasicMaterial color={theme.other} transparent opacity={lit ? 0.12 : 0.22}/></lineSegments>
    <lineSegments geometry={lines.near}><lineBasicMaterial color={theme.near} transparent opacity={lit ? 0.08 : 0.2}/></lineSegments>
    {/* WorldLabel, not drei's Html: its DOM root is removed after React finishes, so leaving the page never breaks. */}
    {labelled.map(position => <WorldLabel key={graph.nodes[position].id} position={[positions[position * 3], positions[position * 3 + 1], positions[position * 3 + 2]]} distanceFactor={radius * 2}>
      <span className={`graph-label${reading?.includes(graph.nodes[position].id) ? ' reading' : ''}`}>{graph.nodes[position].title}</span>
    </WorldLabel>)}
    <OrbitControls makeDefault enableDamping autoRotate={!still && hover === null} autoRotateSpeed={0.35} minDistance={4} maxDistance={radius * 5}/>
  </Canvas>;
}
