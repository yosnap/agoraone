import { Suspense, useMemo, useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { Place } from '../data/city';
import { cityGrid, curb } from './city-layout';
import { useDaylight } from './daylight';
import { useHuman } from './human-figure';
import { blendGait, patrol } from './walker';

// Generic passers-by: pure ambience, never tied to a profile or to Hermes activity.
// No label, no ring, not selectable, neutral clothing (profiles wear their colour).
const clothes = ['#8d9196', '#5d6c7c', '#a59c8c', '#6f7b66', '#7b6a62'];
type Stroll = { z: number; from: number; length: number; pace: number; delay: number; seed: number; tint: string };

function Pedestrian({ stroll }: { stroll: Stroll }) {
  const holder = useRef<Group>(null);
  const rig = useHuman(stroll.seed, stroll.tint);
  useFrame(({ clock }, delta) => {
    const group = holder.current;
    if (!group) return;
    const step = patrol(clock.elapsedTime + stroll.delay, stroll.length, stroll.pace, 1.6);
    group.position.x = stroll.from + step.offset;
    const facing = step.forward ? Math.PI / 2 : -Math.PI / 2;
    group.rotation.y += (facing - group.rotation.y) * Math.min(1, delta * 4);
    blendGait(rig, step.moving, delta);
  });
  return <group ref={holder} position={[stroll.from, curb, stroll.z]}><primitive object={rig.root}/></group>;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function CityPedestrians({ places, extent }: { places: Place[]; extent: number }) {
  const { night } = useDaylight();
  const reduced = useReducedMotion();
  const strolls = useMemo(() => {
    const grid = cityGrid(places, extent);
    const from = -grid.span / 2 + 1.5, length = grid.span - 3;
    // North sidewalk of each avenue, close to the kerb: clear of trees, benches and the profiles' path.
    return grid.avenues.flatMap((avenue, a) => [0, 1].map(k => {
      const seed = a * 2 + k;
      return { z: avenue + 1.45 + k * 0.4, from, length, pace: 0.95 + (seed % 3) * 0.15, delay: seed * 7.3, seed: seed + 11, tint: clothes[seed % clothes.length] };
    })).slice(0, 6);
  }, [places, extent]);
  if (reduced) return null;
  const visible = night > 0.6 ? strolls.filter((_, i) => i % 2 === 0) : strolls;
  return <group>{visible.map(stroll => <Suspense key={`${stroll.z}:${stroll.seed}`} fallback={null}><Pedestrian stroll={stroll}/></Suspense>)}</group>;
}
