import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { WorldLabel } from '../world/world-label';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, InstancedMesh, Object3D, Vector3 } from 'three';
import type { BrainGraph } from '../api/core';
import { gather } from './graph-motion';

import { useResolvedTheme } from '../shell/theme';

// What CSS cannot reach: the scene's own colours per theme.
const scene = {
  light: { background: '#f1f2ea', dim: new Color('#c9cfc6'), link: '#4f6f66', near: '#b08a3e', other: '#8a7aa8', synapse: '#c2410c', pulse: '#ea580c' },
  dark: { background: '#08121c', dim: new Color('#233646'), link: '#5fd3e6', near: '#d9a94a', other: '#9d8fd0', synapse: '#7dd3fc', pulse: '#e0f2fe' },
};
const holder = new Object3D();
const EASE = 3.2; // how fast spheres travel to their new place (per second)

// `changed`: whether any sphere moved this frame; lines skip their work while everything is at rest.
type Moving = { current: Float32Array; target: Float32Array; changed: boolean };

/** One sphere per node, moved every frame towards its target; lit ones breathe. */
function Nodes({ graph, moving, lit, rank, colors, typeColors, dim, still, ...events }: {
  graph: BrainGraph; moving: Moving; lit: Set<string> | null; rank: Map<number, number>; colors: Map<string, string>;
  typeColors: Partial<Record<string, string>>; dim: Color; still: boolean;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => void; onPointerOut: () => void; onClick: (event: ThreeEvent<MouseEvent>) => void;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const sizes = useMemo(() => graph.nodes.map(node => node.type === 'note' ? 0.32 + Math.sqrt(node.degree) * 0.13 : 0.5 + Math.sqrt(node.degree) * 0.16), [graph]);
  useLayoutEffect(() => {
    const instances = mesh.current;
    if (!instances) return;
    graph.nodes.forEach((node, position) => {
      instances.setColorAt(position, lit && !lit.has(node.id) ? dim : new Color(node.type === 'note' ? colors.get((node.folder ?? '').split('/')[0]) ?? '#9a93a8'
        : node.type === 'folder' ? colors.get(node.id.split('/')[1] ?? '') ?? '#9a93a8' : typeColors[node.type] ?? '#9a93a8'));
    });
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
  }, [graph, lit, colors, typeColors, dim]);
  useFrame((state, delta) => {
    const instances = mesh.current;
    if (!instances) return;
    const { current, target } = moving;
    const step = still ? 1 : 1 - Math.exp(-EASE * Math.min(delta, 0.1));
    const time = state.clock.elapsedTime;
    let moved = false;
    for (let position = 0; position < graph.nodes.length; position++) {
      const at = position * 3;
      for (let axis = 0; axis < 3; axis++) {
        const gap = target[at + axis] - current[at + axis];
        if (gap > 0.001 || gap < -0.001) { current[at + axis] += gap * step; moved = true; } else current[at + axis] = target[at + axis];
      }
      holder.position.set(current[at], current[at + 1], current[at + 2]);
      const order = rank.get(position);
      const breathe = order === undefined || still ? 1 : 1 + 0.14 * Math.sin(time * 3 - order * 0.6);
      holder.scale.setScalar(order === undefined ? sizes[position] * (rank.size ? 0.4 : 1) : sizes[position] * (order === 0 ? 2.4 : 1.7) * breathe);
      holder.updateMatrix();
      instances.setMatrixAt(position, holder.matrix);
    }
    instances.instanceMatrix.needsUpdate = true;
    if (moved || !moving.changed) instances.computeBoundingSphere();
    moving.changed = moved;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, graph.nodes.length]} {...events}>
    <sphereGeometry args={[1, 18, 14]}/>
    <meshStandardMaterial roughness={0.55}/>
  </instancedMesh>;
}

/** Line segments between node pairs that follow the moving spheres. */
function Lines({ pairs, moving, color, opacity, additive = false }: { pairs: [number, number][]; moving: Moving; color: string; opacity: number; additive?: boolean }) {
  const geometry = useMemo(() => {
    const made = new BufferGeometry();
    made.setAttribute('position', new BufferAttribute(new Float32Array(pairs.length * 6), 3));
    return made;
  }, [pairs]);
  const written = useRef(false);
  useFrame(() => {
    if (written.current && !moving.changed) return;
    const points = geometry.getAttribute('position') as BufferAttribute;
    const array = points.array as Float32Array, { current } = moving;
    for (let index = 0; index < pairs.length; index++) {
      const [a, b] = pairs[index];
      for (let axis = 0; axis < 3; axis++) { array[index * 6 + axis] = current[a * 3 + axis]; array[index * 6 + 3 + axis] = current[b * 3 + axis]; }
    }
    points.needsUpdate = true;
    geometry.computeBoundingSphere();
    written.current = true;
  });
  return <lineSegments geometry={geometry}>
    <lineBasicMaterial color={color} transparent opacity={opacity} blending={additive ? AdditiveBlending : undefined} depthWrite={!additive}/>
  </lineSegments>;
}

/** Sparks that run along each synapse, like a signal between neurons. */
function Pulses({ pairs, moving, color, still, glow }: { pairs: [number, number][]; moving: Moving; color: string; still: boolean; glow: boolean }) {
  const PER = 2;
  const geometry = useMemo(() => {
    const made = new BufferGeometry();
    made.setAttribute('position', new BufferAttribute(new Float32Array(pairs.length * PER * 3), 3));
    return made;
  }, [pairs]);
  useFrame(state => {
    const points = geometry.getAttribute('position') as BufferAttribute;
    const { current } = moving;
    const time = state.clock.elapsedTime;
    pairs.forEach(([a, b], index) => {
      for (let spark = 0; spark < PER; spark++) {
        const phase = still ? 0.5 : (time * 0.55 + index * 0.137 + spark / PER) % 1;
        const at = (index * PER + spark) * 3;
        for (let axis = 0; axis < 3; axis++) points.array[at + axis] = current[a * 3 + axis] + (current[b * 3 + axis] - current[a * 3 + axis]) * phase;
      }
    });
    points.needsUpdate = true;
    geometry.computeBoundingSphere();
  });
  return <points geometry={geometry}>
    <pointsMaterial color={color} size={1.1} sizeAttenuation transparent opacity={0.95} blending={glow ? AdditiveBlending : undefined} depthWrite={false}/>
  </points>;
}

/** The camera glides to the constellation (pivot and distance) for two seconds, then leaves the user free;
 * clearing brings it back to the whole brain. */
function Focus({ focus, distance, still }: { focus: [number, number, number]; distance: number; still: boolean }) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as unknown as { target: Vector3 } | null;
  const goal = useMemo(() => new Vector3(...focus), [focus]);
  const glide = useRef({ goal, distance, since: 0 });
  useFrame((_, delta) => {
    // A new focus or distance restarts the glide.
    if (glide.current.goal !== goal || glide.current.distance !== distance) glide.current = { goal, distance, since: 0 };
    if (!controls || glide.current.since > 2) return;
    glide.current.since += delta;
    const step = still ? 1 : 1 - Math.exp(-2.4 * Math.min(delta, 0.1));
    controls.target.lerp(goal, step);
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.lerp(controls.target.clone().add(direction.multiplyScalar(distance)), step);
  });
  return null;
}

/** The graph in 3D: one sphere per note (size by connections, colour by top folder), solid lines for real
 * links and faint ones for closeness in meaning. When something is lit (a search, a picked note, what Watson
 * reads) the found notes travel into a constellation with the best match at its centre, the rest step aside,
 * and synapses with running sparks join them; clearing it brings everything back. It turns slowly by itself,
 * and nothing moves when the system asks to reduce motion. */
export default function BrainGraphScene({ graph, positions, lit, colors, typeColors, reading, onPick, still }: {
  graph: BrainGraph; positions: Float32Array; lit: Set<string> | null; colors: Map<string, string>; typeColors: Partial<Record<string, string>>;
  reading: string[] | null; onPick: (index: number) => void; still: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const resolved = useResolvedTheme();
  const theme = scene[resolved];
  const radius = useMemo(() => {
    let far = 10;
    for (let index = 0; index < positions.length; index += 3) far = Math.max(far, Math.hypot(positions[index], positions[index + 1], positions[index + 2]));
    return far;
  }, [positions]);
  const index = useMemo(() => new Map(graph.nodes.map((node, position) => [node.id, position])), [graph]);
  const edges = useMemo(() => {
    const byKind: Record<'link' | 'near' | 'other', [number, number][]> = { link: [], near: [], other: [] };
    for (const edge of graph.edges) {
      const a = index.get(edge.a), b = index.get(edge.b);
      if (a === undefined || b === undefined) continue;
      byKind[edge.kind === 'link' ? 'link' : edge.kind === 'near' ? 'near' : 'other'].push([a, b]);
    }
    return byKind;
  }, [graph, index]);
  // Lit first (a search keeps its ranking: the best match leads), then what Watson is reading.
  const order = useMemo(() => {
    const ids = [...(lit ?? []), ...(reading ?? [])];
    return [...new Set(ids.map(id => index.get(id)).filter((position): position is number => position !== undefined))];
  }, [lit, reading, index]);
  const rank = useMemo(() => new Map(order.map((position, at) => [position, at])), [order]);
  const motion = useMemo(() => gather(positions, order, [...edges.link, ...edges.other, ...edges.near]), [positions, order, edges]);
  const moving = useRef<Moving | null>(null);
  if (!moving.current || moving.current.current.length !== positions.length) moving.current = { current: positions.slice(), target: positions, changed: true };
  moving.current.target = motion.target;
  const labelled = useMemo(() => {
    const chosen = new Set<number>();
    if (hover !== null) chosen.add(hover);
    // The ten most connected entities, tags and folders keep their name on screen while nothing is lit.
    if (!order.length) graph.nodes.map((node, position) => ({ node, position })).filter(item => item.node.type !== 'note')
      .sort((a, b) => b.node.degree - a.node.degree).slice(0, 10).forEach(item => chosen.add(item.position));
    order.slice(0, 6).forEach(position => chosen.add(position));
    return [...chosen];
  }, [hover, order, graph]);
  const litIds = useMemo(() => order.length ? new Set(order.map(position => graph.nodes[position].id)) : null, [order, graph]);
  const point = (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); if (event.instanceId !== undefined) setHover(event.instanceId); };
  const active = order.length > 0;
  const glow = resolved === 'dark'; // additive light only shows on a dark background
  const at = (position: number): [number, number, number] => [motion.target[position * 3], motion.target[position * 3 + 1], motion.target[position * 3 + 2]];
  return <Canvas camera={{ position: [0, radius * 0.4, radius * 2.1], fov: 45, near: 0.1, far: radius * 10 }} dpr={[1, 1.7]}
    onPointerMissed={() => setHover(null)} aria-label="Grafo del cerebro">
    <color attach="background" args={[theme.background]}/>
    <ambientLight intensity={1.6}/>
    <directionalLight position={[radius, radius, radius]} intensity={1.4}/>
    <Nodes key={graph.nodes.length} graph={graph} moving={moving.current} lit={litIds}
      rank={rank} colors={colors} typeColors={typeColors} dim={theme.dim} still={still}
      onPointerMove={point} onPointerOut={() => setHover(null)}
      onClick={event => { event.stopPropagation(); if (event.instanceId !== undefined) onPick(event.instanceId); }}/>
    <Lines pairs={edges.link} moving={moving.current} color={theme.link} opacity={active ? 0.06 : 0.45}/>
    <Lines pairs={edges.other} moving={moving.current} color={theme.other} opacity={active ? 0.04 : 0.22}/>
    <Lines pairs={edges.near} moving={moving.current} color={theme.near} opacity={active ? 0.03 : 0.2}/>
    {active && <Lines pairs={motion.synapses} moving={moving.current} color={theme.synapse} opacity={glow ? 1 : 0.9} additive={glow}/>}
    {active && <Pulses pairs={motion.synapses} moving={moving.current} color={theme.pulse} still={still} glow={glow}/>}
    <Focus focus={motion.focus} distance={active ? Math.max(16, motion.reach * 3.4) : radius * 2.15} still={still}/>
    {/* WorldLabel, not drei's Html: its DOM root is removed after React finishes, so leaving the page never breaks.
        Labels sit where their sphere is heading, which it reaches in about a second. */}
    {labelled.map(position => <WorldLabel key={graph.nodes[position].id} position={at(position)} distanceFactor={radius * 2}>
      <span className={`graph-label${reading?.includes(graph.nodes[position].id) ? ' reading' : ''}${rank.get(position) === 0 ? ' best' : ''}`}>{graph.nodes[position].title}</span>
    </WorldLabel>)}
    <OrbitControls makeDefault enableDamping autoRotate={!still && hover === null} autoRotateSpeed={active ? 0.6 : 0.35} minDistance={4} maxDistance={radius * 5}/>
  </Canvas>;
}
