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

/** What the agent is really doing, as a pose: strolling (nothing recorded now), at its desk typing (working:
 * a tool, a scheduled task, answering you or activity in the last minutes) or standing at its desk with arms
 * folded (waiting for your permission). Only real states move it; see agent-state.ts. */
export type AgentPose = 'stroll' | 'desk' | 'wait';

/** Cross-fades the four motions so the person never snaps from one to another. */
function blendPose(rig: HumanRig, target: { idle: number; walk: number; sit: number; fold: number }, delta: number, frozen: boolean) {
  const k = Math.min(1, delta * 4);
  (['idle', 'walk', 'sit', 'fold'] as const).forEach(name => {
    const action = rig[name], now = action.getEffectiveWeight();
    action.setEffectiveWeight(frozen ? target[name] : now + (target[name] - now) * k);
  });
  rig.mixer.update(frozen ? 0 : delta);
}

const DESK_Z = -0.62;  // the desk, between the person and the building
const SEAT_Z = 0.16;   // the chair, behind the person; tuned to Quaternius' seated clip
const LANE_Z = 0.95;   // the stroll goes in front of the desk and chair, never through them
const WAIT_X = 0.85;   // waiting for permission: standing beside the desk

// Ambient stroll along the sidewalk: walk, pause, turn, walk back. When the agent works for real, it walks to its
// desk in front of the building and sits down to type; waiting for your permission, it stands there arms folded.
// Stops facing the viewer when selected, and never animates when the user prefers reduced motion.
function Person({ color, phase, selected, pose, onSelect }: { color: string; phase: number; selected: boolean; pose: AgentPose; onSelect: () => void }) {
  const holder = useRef<Group>(null);
  const reducedMotion = usePrefersReducedMotion();
  const rig = useHuman(phase, color);
  useFrame(({ clock }, delta) => {
    const group = holder.current;
    if (!group) return;
    const reduced = reducedMotion.current;
    const atDesk = pose !== 'stroll';
    const step = patrol(clock.elapsedTime + phase * 3.7, range * 2, speed, pause);
    const target = pose === 'desk' ? 0 : pose === 'wait' ? WAIT_X : selected ? group.position.x : step.offset - range;
    // Follow the target at walking pace so switching between ambient and real activity never teleports.
    const gap = target - group.position.x;
    const travel = reduced ? gap : Math.sign(gap) * Math.min(Math.abs(gap), speed * 1.4 * delta);
    group.position.x += travel;
    const walking = !reduced && Math.abs(gap) > 0.03;
    const seated = pose === 'desk' && !walking;
    // Into the chair and out of it smoothly, never jumping; strolling, along the lane in front of the desk.
    const seatGoal = seated ? SEAT_Z : atDesk ? 0 : LANE_Z;
    group.position.z += reduced ? seatGoal - group.position.z : (seatGoal - group.position.z) * Math.min(1, delta * 3);
    const facing = walking ? (gap > 0 ? Math.PI / 2 : -Math.PI / 2) : atDesk ? Math.PI : selected || reduced ? 0 : step.forward ? Math.PI / 2 : -Math.PI / 2;
    const turn = ((facing - group.rotation.y + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // shortest way round
    group.rotation.y += reduced ? turn : turn * Math.min(1, delta * 4);
    const strolling = walking || (!atDesk && !selected && !reduced && step.moving);
    blendPose(rig, seated ? { idle: 0, walk: 0, sit: 1, fold: 0 }
      : pose === 'wait' && !walking ? { idle: 0, walk: 0, sit: 0, fold: 1 }
      : { idle: strolling ? 0 : 1, walk: strolling ? 1 : 0, sit: 0, fold: 0 }, delta, reduced);
  });
  return <group ref={holder} onClick={event => { event.stopPropagation(); onSelect(); }}><primitive object={rig.root}/></group>;
}

/** The agent's desk on the sidewalk: a table, a chair and a monitor that lights up only while it works. */
function Desk({ working, color }: { working: boolean; color: string }) {
  return <group>
    <mesh position={[0, 0.72, DESK_Z]} castShadow receiveShadow><boxGeometry args={[1.2, 0.05, 0.6]}/><meshStandardMaterial color="#8a6a4a" roughness={0.7}/></mesh>
    {[[-0.55, -0.25], [0.55, -0.25], [-0.55, 0.25], [0.55, 0.25]].map(([x, z]) =>
      <mesh key={`${x}${z}`} position={[x, 0.36, DESK_Z + z]} castShadow><boxGeometry args={[0.05, 0.72, 0.05]}/><meshStandardMaterial color="#4a3a2c"/></mesh>)}
    <group position={[0, 0.75, DESK_Z - 0.12]}>
      <mesh position={[0, 0.03, 0]}><boxGeometry args={[0.22, 0.04, 0.14]}/><meshStandardMaterial color="#2c2f33"/></mesh>
      <mesh position={[0, 0.14, 0]}><boxGeometry args={[0.04, 0.2, 0.04]}/><meshStandardMaterial color="#2c2f33"/></mesh>
      <mesh position={[0, 0.38, 0]} castShadow><boxGeometry args={[0.62, 0.38, 0.04]}/><meshStandardMaterial color="#1f2226"/></mesh>
      {/* The screen faces the person; it glows only while the agent really works. */}
      <mesh position={[0, 0.38, 0.022]}><planeGeometry args={[0.56, 0.32]}/>
        <meshStandardMaterial color={working ? '#bfe3ff' : '#0d0f12'} emissive={working ? color : '#000000'} emissiveIntensity={working ? 1.6 : 0} toneMapped={!working}/></mesh>
    </group>
    <mesh position={[0, 0.76, DESK_Z + 0.16]}><boxGeometry args={[0.42, 0.02, 0.14]}/><meshStandardMaterial color="#d8d8d2"/></mesh>
    <group position={[0, 0, SEAT_Z + 0.12]}>
      <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[0.46, 0.06, 0.44]}/><meshStandardMaterial color="#3b4a56"/></mesh>
      <mesh position={[0, 0.75, 0.2]} castShadow><boxGeometry args={[0.46, 0.55, 0.05]}/><meshStandardMaterial color="#3b4a56"/></mesh>
      <mesh position={[0, 0.22, 0]}><cylinderGeometry args={[0.03, 0.03, 0.44, 8]}/><meshStandardMaterial color="#2c2f33"/></mesh>
    </group>
  </group>;
}

export function Walker({ color, phase, selected, pose = 'stroll', onSelect }: { color: string; phase: number; selected: boolean; pose?: AgentPose; onSelect: () => void }) {
  return <group position={[0, curb, 3]}>
    <Desk working={pose === 'desk'} color={color}/>
    <mesh position={[0, 0.01, LANE_Z]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.65, 0.82, 32]}/><meshBasicMaterial color={selected ? '#fff5bd' : pose !== 'stroll' ? '#ffd27a' : color} transparent opacity={0.85}/></mesh>
    <Suspense fallback={null}><Person color={color} phase={phase} selected={selected} pose={pose} onSelect={onSelect}/></Suspense>
  </group>;
}
