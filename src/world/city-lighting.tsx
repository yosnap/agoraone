import { Suspense, useMemo } from 'react';
import { Environment, Lightformer } from '@react-three/drei';
import { SkyEnvironment } from './sky-environment';
import { BackSide, Color } from 'three';
import { useDaylight } from './daylight';

const mix = (a: string, b: string, t: number) => `#${new Color(a).lerp(new Color(b), t).getHexString()}`;

// Sun follows the shared daylight state; sky, fog and ambient light come from the HDRI.
// At night a cool moonlight takes over.
export function CityLighting({ extent, firstPerson }: { extent: number; firstPerson: boolean }) {
  const { sun, night, dusk, elevation } = useDaylight();
  const reach = extent + 4;
  const light = useMemo(() => {
    const day = Math.max(0, Math.min(1, (elevation + 2) / 12));
    const moon: [number, number, number] = [-sun[0] * 0.6, 0.75, -sun[2] * 0.6];
    const towards = night > 0.6 ? moon : sun;
    return {
      position: towards.map(v => v * extent * 2) as [number, number, number],
      intensity: night > 0.6 ? 0.5 : 3.8 * day,
      color: night > 0.6 ? '#9db4ff' : mix('#fff4e2', '#ffad6b', dusk),
      skyTint: mix('#eaf3f6', '#1a2944', night),
      ground: mix('#7d8a63', '#0e130f', night),
      hemi: 0.2 - night * 0.1,
    };
  }, [sun, night, dusk, elevation, extent]);
  const near = firstPerson ? extent * 1.8 : extent * 3.4, far = firstPerson ? extent * 6 : extent * 8;
  return <>
    <Suspense fallback={null}><SkyEnvironment near={near} far={far}/></Suspense>
    <hemisphereLight args={[light.skyTint, light.ground, light.hemi]}/>
    <directionalLight position={light.position} intensity={light.intensity} color={light.color} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.03}
      shadow-camera-left={-reach} shadow-camera-right={reach} shadow-camera-top={reach} shadow-camera-bottom={-reach} shadow-camera-far={extent * 6}/>
  </>;
}

// Interior reflections rendered from light shapes in the scene itself.
export function Reflections() {
  const { night } = useDaylight();
  // Rebuilt only when the light bucket changes; the dome gives glass a sky to reflect.
  return <Environment key={Math.round(night * 4)} resolution={128} frames={1} environmentIntensity={0.65 - night * 0.5}>
    <mesh scale={50}><sphereGeometry args={[1, 24, 12]}/><meshBasicMaterial color={mix('#a9c3cf', '#0b1524', night)} side={BackSide}/></mesh>
    <Lightformer form="rect" intensity={2} color="#f4f8f6" position={[0, 6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 12, 1]}/>
    <Lightformer form="rect" intensity={1.2} color="#ffe7c2" position={[-6, 2, 4]} rotation={[0, Math.PI / 3, 0]} scale={[8, 3, 1]}/>
    <Lightformer form="rect" intensity={0.8} color="#bfd8e0" position={[6, 2, -4]} rotation={[0, -Math.PI / 1.5, 0]} scale={[8, 3, 1]}/>
  </Environment>;
}
