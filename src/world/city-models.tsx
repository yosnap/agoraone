import { useLayoutEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { Box3, Euler, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3, type InstancedMesh, type Material, type Object3D } from 'three';
import { useDaylight } from './daylight';

// CC0 models from Poly Haven, decimated and meshopt-compressed for the browser
// (see docs/recursos-visuales.md). Loaded locally; never from a CDN.
export const models = {
  olive: '/world/models/island_tree_01.glb',
  oliveTwisted: '/world/models/island_tree_02.glb',
  lamp: '/world/models/street_lamp_01.glb',
  hydrant: '/world/models/fire_hydrant.glb',
} as const;
type ModelKey = keyof typeof models;
export type Placement = { position: [number, number, number]; rotation?: number; scale?: number };

const everything = () => true;

/** Meshes of a model with their baked node transforms; optional name filter. */
function useParts(key: ModelKey, keep: (object: Object3D) => boolean = everything) {
  const { scene } = useGLTF(models[key], false, true);
  return useMemo(() => {
    scene.updateMatrixWorld(true);
    const parts: { mesh: Mesh; base: Matrix4 }[] = [];
    scene.traverse(object => {
      if (object instanceof Mesh && keep(object) && (!object.parent || keep(object.parent))) parts.push({ mesh: object, base: object.matrixWorld.clone() });
    });
    // Recentre horizontally on the kept parts so placements stand on their own footprint.
    const box = new Box3();
    parts.forEach(({ mesh, base }) => { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(base)); });
    const centre = new Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    parts.forEach(part => part.base.premultiply(centre));
    return parts;
  }, [scene, keep]);
}

function InstancedPart({ mesh, base, placements, material }: { mesh: Mesh; base: Matrix4; placements: Placement[]; material?: Material }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const instance = ref.current;
    if (!instance) return;
    const matrix = new Matrix4(), q = new Quaternion(), s = new Vector3(), e = new Euler();
    placements.forEach((p, i) => {
      const k = p.scale ?? 1;
      matrix.compose(new Vector3(...p.position), q.setFromEuler(e.set(0, p.rotation ?? 0, 0)), s.set(k, k, k)).multiply(base);
      instance.setMatrixAt(i, matrix);
    });
    instance.instanceMatrix.needsUpdate = true;
    instance.computeBoundingSphere();
  }, [placements, base]);
  return <instancedMesh ref={ref} args={[mesh.geometry, material ?? mesh.material, placements.length]} castShadow receiveShadow frustumCulled={false}/>;
}

/** One draw call per model part, however many copies are placed. */
export function ModelInstances({ model, placements, keep }: { model: ModelKey; placements: Placement[]; keep?: (object: Object3D) => boolean }) {
  const parts = useParts(model, keep);
  if (!placements.length) return null;
  return <group>{parts.map(({ mesh, base }) => <InstancedPart key={mesh.uuid} mesh={mesh} base={base} placements={placements}/>)}</group>;
}

const hydrantPart = (object: Object3D) => !object.name.includes('aged');
export function Hydrants({ placements }: { placements: Placement[] }) {
  return <ModelInstances model="hydrant" placements={placements} keep={hydrantPart}/>;
}

/** Street lamps whose bulbs and glass glow according to the time of day. */
export function StreetLamps({ placements }: { placements: Placement[] }) {
  const { night } = useDaylight();
  const parts = useParts('lamp');
  useLayoutEffect(() => {
    parts.forEach(({ mesh }) => {
      const material = mesh.material as MeshStandardMaterial;
      if (!/bulb|glass/.test(material.name)) return;
      material.emissive.set('#ffcf8a');
      material.emissiveIntensity = material.name.includes('bulb') ? 0.2 + night * 9 : night * 1.5;
      material.toneMapped = false;
    });
  }, [parts, night]);
  return <group>{parts.map(({ mesh, base }) => <InstancedPart key={mesh.uuid} mesh={mesh} base={base} placements={placements}/>)}</group>;
}

Object.values(models).forEach(url => useGLTF.preload(url, false, true));
