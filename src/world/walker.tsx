import { Suspense, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { curb } from './city-layout';
import { useHuman, type HumanRig } from './human-figure';

const range = 1.8, speed = 0.75, pause = 2.6;

/** Back-and-forth walk along a segment with a pause and turn at each end. */
export function patrol(time: number, length: number, pace: number, rest: number) {
  const walkTime = length / pace, cycle = 2 * (walkTime + rest);
  const t = (time % cycle + cycle) % cycle;
  if (t < walkTime) return { offset: t * pace, forward: true, moving: true };
  if (t < walkTime + rest) return { offset: length, forward: false, moving: false };
  if (t < 2 * walkTime + rest) return { offset: length - (t - walkTime - rest) * pace, forward: false, moving: true };
  return { offset: 0, forward: true, moving: false };
}

/** Cross-fades walk and idle so feet never slide while standing. */
export function blendGait(rig: HumanRig, moving: boolean, delta: number, frozen = false) {
  const k = Math.min(1, delta * 5), current = rig.walk.getEffectiveWeight();
  const weight = current + ((moving ? 1 : 0) - current) * k;
  rig.walk.setEffectiveWeight(weight); rig.idle.setEffectiveWeight(1 - weight);
  rig.mixer.update(frozen ? 0 : delta);
}

export function usePrefersReducedMotion() {
  const reduced = useRef(true);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reduced.current = media.matches; };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

// Ambient stroll along the sidewalk: walk, pause, turn, walk back. Pure animation that
// never reflects real Hermes work. Stops facing the viewer when selected or when the
// user prefers reduced motion.
function Person({ color, phase, selected, onSelect }: { color: string; phase: number; selected: boolean; onSelect: () => void }) {
  const holder = useRef<Group>(null);
  const reducedMotion = usePrefersReducedMotion();
  const rig = useHuman(phase, color);
  useFrame(({ clock }, delta) => {
    const group = holder.current;
    if (!group) return;
    const still = selected || reducedMotion.current;
    const step = patrol(clock.elapsedTime + phase * 3.7, range * 2, speed, pause);
    if (!still) group.position.x = step.offset - range;
    const facing = still ? 0 : step.forward ? Math.PI / 2 : -Math.PI / 2;
    group.rotation.y += (facing - group.rotation.y) * Math.min(1, delta * 4);
    blendGait(rig, !still && step.moving, delta, reducedMotion.current);
  });
  return <group ref={holder} onClick={event => { event.stopPropagation(); onSelect(); }}><primitive object={rig.root}/></group>;
}

export function Walker({ color, phase, selected, onSelect }: { color: string; phase: number; selected: boolean; onSelect: () => void }) {
  return <group position={[0, curb, 3]}>
    <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.65, 0.82, 32]}/><meshBasicMaterial color={selected ? '#fff5bd' : color} transparent opacity={0.85}/></mesh>
    <Suspense fallback={null}><Person color={color} phase={phase} selected={selected} onSelect={onSelect}/></Suspense>
  </group>;
}
