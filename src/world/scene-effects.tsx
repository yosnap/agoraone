import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useDaylight } from './daylight';

// Render pipeline: ambient occlusion grounds objects, bloom only catches bright emitters
// (lamps, lit windows), ACES tone mapping keeps contrast and natural highlights.
export function SceneEffects() {
  const { night } = useDaylight();
  return <EffectComposer multisampling={0} enableNormalPass={false}>
    <N8AO halfRes quality="medium" aoRadius={1.6} distanceFalloff={1} intensity={2.4 - night * 1.2} color="#0b1210"/>
    <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.2} intensity={0.35 + night * 0.9}/>
    <ToneMapping mode={ToneMappingMode.ACES_FILMIC}/>
    <SMAA/>
    <Vignette offset={0.3} darkness={0.35}/>
  </EffectComposer>;
}
