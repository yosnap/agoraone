import { useMemo } from 'react';
import { Environment, useEnvironment } from '@react-three/drei';
import { Color, DataUtils, FloatType, type DataTexture } from 'three';
import { useDaylight, type Daylight } from './daylight';

// Photographic CC0 skies (Poly Haven) chosen by sun height: clear day, sunset, night.
// Photographic HDRIs are exposure-normalised; these levels restore real night darkness.
const levels = { day: { env: 1, bg: 1 }, dusk: { env: 0.85, bg: 0.9 }, night: { env: 0.12, bg: 0.18 } } as const;

export function skyFor({ night, dusk }: Daylight) {
  return night > 0.6 ? 'night' : dusk > 0.55 ? 'dusk' : 'day';
}

type SkyInfo = { sunAngle: number; horizon: Color };

// Finds the brightest region (the sun) and the average horizon colour of an equirect HDR.
function analyse(texture: DataTexture): SkyInfo {
  const { data, width, height } = texture.image as { data: ArrayLike<number>; width: number; height: number };
  const read = texture.type === FloatType ? (i: number) => data[i] as number : (i: number) => DataUtils.fromHalfFloat(data[i] as number);
  const channels = data.length / (width * height);
  let best = -1, bestX = 0;
  for (let y = 0; y < height / 2; y += 4) for (let x = 0; x < width; x += 4) {
    const i = (y * width + x) * channels;
    const lum = read(i) * 0.2126 + read(i + 1) * 0.7152 + read(i + 2) * 0.0722;
    if (lum > best) { best = lum; bestX = x; }
  }
  const horizon = new Color(0, 0, 0);
  const row = Math.floor(height * 0.43);
  for (let x = 0; x < width; x += 8) {
    const i = (row * width + x) * channels;
    horizon.r += read(i); horizon.g += read(i + 1); horizon.b += read(i + 2);
  }
  horizon.multiplyScalar(8 / width);
  // three.js equirect: u = atan(z, x) / 2π + 0.5.
  return { sunAngle: (bestX / width - 0.5) * Math.PI * 2, horizon };
}

// Fog takes the sky's own horizon colour so distant ground melts into the photo.
export function SkyEnvironment({ near, far }: { near: number; far: number }) {
  const daylight = useDaylight();
  const name = skyFor(daylight);
  const texture = useEnvironment({ files: `/world/hdri/${name}.hdr` }) as DataTexture;
  const info = useMemo(() => analyse(texture), [texture]);
  // Rotate the sky so its sun sits where the computed sun (and the shadows) are.
  const target = Math.atan2(daylight.sun[2], daylight.sun[0]);
  const rotation: [number, number, number] = [0, name === 'night' ? 0 : info.sunAngle - target, 0];
  const level = levels[name];
  const fog = useMemo(() => info.horizon.clone().multiplyScalar(level.bg), [info, level]);
  return <><fog attach="fog" args={[fog, near, far]}/><Environment map={texture} background environmentIntensity={level.env} backgroundIntensity={level.bg}
    backgroundRotation={rotation} environmentRotation={rotation}/></>;
}
