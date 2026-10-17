import { Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useHuman } from './human-figure';
import { usePrefersReducedMotion } from './walker';

type Vec3 = [number, number, number];

// A person standing in place with the idle loop: ambient, never a sign of real work.
function Body({ seed, color }: { seed: number; color: string }) {
  const rig = useHuman(seed, color);
  const reducedMotion = usePrefersReducedMotion();
  useFrame((_, delta) => rig.mixer.update(reducedMotion.current ? 0 : delta));
  return <primitive object={rig.root}/>;
}

export function StandingPerson({ seed, color, position, rotation = 0, onClick }: { seed: number; color: string; position: Vec3; rotation?: number; onClick?: () => void }) {
  return <group position={position} rotation={[0, rotation, 0]} onClick={onClick && (event => { event.stopPropagation(); onClick(); })}>
    <Suspense fallback={null}><Body seed={seed} color={color}/></Suspense>
  </group>;
}
