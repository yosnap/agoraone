import { useTexture } from '@react-three/drei';
import { RepeatWrapping, SRGBColorSpace, Vector3, type BufferGeometry, type Texture } from 'three';

// CC0 photographic PBR sets from Poly Haven (see docs/recursos-visuales.md).
// `tile` is the real-world size in metres covered by one texture repeat.
export const surfaces = {
  asphalt: { dir: 'asphalt_02', tile: 4 },
  grass: { dir: 'leafy_grass', tile: 3 },
  paving: { dir: 'concrete_pavement', tile: 2 },
  stucco: { dir: 'white_stucco', tile: 2.5 },
  roof: { dir: 'grey_roof_tiles_02', tile: 2 },
  concrete: { dir: 'concrete_wall_008', tile: 2.5 },
  wood: { dir: 'wood_floor', tile: 2 },
} as const;
export type SurfaceKind = keyof typeof surfaces;

const prepared = new WeakSet<Texture>();

/** Texture maps for one surface; repeats are set once per shared, cached texture. */
export function useSurface(kind: SurfaceKind) {
  const { dir, tile } = surfaces[kind];
  const base = `/world/textures/${dir}`;
  const [map, normalMap, roughnessMap] = useTexture([`${base}/diffuse.jpg`, `${base}/nor_gl.jpg`, `${base}/rough.jpg`]);
  [map, normalMap, roughnessMap].forEach(texture => {
    if (prepared.has(texture)) return;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(1 / tile, 1 / tile);
    texture.anisotropy = 8;
    prepared.add(texture);
  });
  map.colorSpace = SRGBColorSpace;
  return { map, normalMap, roughnessMap };
}

/** Material with photographic maps, optionally tinted (multiplied) by a colour. */
export function SurfaceMaterial({ kind, color = '#ffffff', roughness = 1, metalness = 0 }: { kind: SurfaceKind; color?: string; roughness?: number; metalness?: number }) {
  const maps = useSurface(kind);
  return <meshStandardMaterial {...maps} color={color} roughness={roughness} metalness={metalness}/>;
}

const normal = new Vector3();
/** Box-projected UVs in metres, so textures keep real scale on any size of geometry. */
export function meterUV<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.attributes.position, normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  if (!position || !normals || !uv) return geometry;
  for (let i = 0; i < position.count; i++) {
    normal.fromBufferAttribute(normals, i);
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (ay >= ax && ay >= az) uv.setXY(i, x, z);
    else if (ax >= az) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
  return geometry;
}
