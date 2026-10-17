import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { AnimationMixer, Box3, Color, LoopRepeat, Skeleton, type AnimationAction, type Bone, type BufferGeometry, type Group, type Material, type MeshStandardMaterial, type Object3D, type SkinnedMesh } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// CC0 humanoids by Quaternius (Universal Base Characters, Modular Outfits, Universal
// Animation Library); see docs/recursos-visuales.md. All parts share one skeleton.
const base = '/world/humans/';
// Full body (head, eyes, brows, default hair) dressed with an outfit and optional extras.
// Only head and neck are kept from the full body: the outfit supplies torso, arms and legs.
const looks = [
  { body: 'Regular_Male_FullBody', parts: ['Male_Peasant', 'Hair_SimpleParted'], hair: '#3b2a1e' },
  { body: 'Regular_Female_FullBody', parts: ['Female_Peasant', 'Hair_Long'], hair: '#6b4428' },
  { body: 'Regular_Male_FullBody', parts: ['Male_Peasant', 'Hair_SimpleParted', 'Hair_Beard'], hair: '#1f1a17' },
  { body: 'Regular_Female_FullBody', parts: ['Female_Peasant', 'Hair_Buns'], hair: '#a8774a' },
] as const;
const headBones = new Set(['head', 'neck_01', 'neck_02']);
const trimmed = new WeakMap<BufferGeometry, BufferGeometry>();

/** Keeps only triangles driven by head/neck bones so the naked body never pokes through clothes. */
function headOnly(mesh: SkinnedMesh) {
  const source = mesh.geometry;
  const cached = trimmed.get(source);
  if (cached) return cached;
  const index = mesh.skeleton.bones.map(bone => headBones.has(bone.name.toLowerCase()));
  const joints = source.attributes.skinIndex, weights = source.attributes.skinWeight;
  const dominant = (v: number) => {
    let best = 0, bone = 0;
    for (let k = 0; k < 4; k++) { const w = weights.getComponent(v, k); if (w > best) { best = w; bone = joints.getComponent(v, k); } }
    return index[bone];
  };
  const order = source.index ? Array.from(source.index.array) : Array.from({ length: source.attributes.position.count }, (_, i) => i);
  const kept: number[] = [];
  for (let i = 0; i < order.length; i += 3) if (dominant(order[i]) && dominant(order[i + 1]) && dominant(order[i + 2])) kept.push(order[i], order[i + 1], order[i + 2]);
  const geometry = source.clone();
  geometry.setIndex(kept);
  trimmed.set(source, geometry);
  return geometry;
}
const files = [...new Set(looks.flatMap(look => [look.body, ...look.parts]))];
const height = 1.74;

export type HumanRig = { root: Group; mixer: AnimationMixer; idle: AnimationAction; walk: AnimationAction };

/** Deterministic look per seed: the same profile always gets the same person. */
export function useHuman(seed: number, tint: string): HumanRig {
  const look = looks[Math.abs(Math.round(seed)) % looks.length];
  const body = useGLTF(`${base}${look.body}.glb`, false, true);
  const parts = useGLTF(look.parts.map(part => `${base}${part}.glb`), false, true);
  const { animations } = useGLTF(`${base}humans-animations.glb`, false, true);
  const rig = useMemo(() => {
    const root = cloneSkinned(body.scene) as Group;
    const bones = new Map<string, Bone>();
    root.traverse(object => {
      if ((object as Bone).isBone) bones.set(object.name, object as Bone);
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh && (mesh.material as Material).name.startsWith('MI_Regular')) mesh.geometry = headOnly(mesh);
    });
    // Outfits and extras keep their own node layout but are re-bound to the body's bones.
    parts.forEach(part => {
      const attached = cloneSkinned(part.scene);
      root.add(attached);
      attached.traverse(object => {
        const mesh = object as SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        mesh.bind(new Skeleton(mesh.skeleton.bones.map(bone => bones.get(bone.name) ?? bone), mesh.skeleton.boneInverses), mesh.bindMatrix);
      });
    });
    // Clothing takes a soft tint of the profile colour so each person stays recognisable.
    const shirt = new Color('#ffffff').lerp(new Color(tint), 0.4);
    root.traverse((object: Object3D) => {
      const mesh = object as SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      const material = mesh.material as Material;
      // Hair textures are neutral grey by design and expect a colour.
      const colour = material.name.includes('Peasant') ? shirt : material.name.includes('Hair') ? new Color(look.hair) : null;
      if (colour) {
        const dyed = (material as MeshStandardMaterial).clone();
        dyed.color.copy(colour);
        mesh.material = dyed;
      }
    });
    const box = new Box3().setFromObject(root);
    root.scale.setScalar(height / Math.max(0.01, box.max.y - box.min.y));
    const mixer = new AnimationMixer(root);
    const clip = (name: string) => animations.find(item => item.name === name) ?? animations[0];
    const idle = mixer.clipAction(clip('Idle_Loop'));
    const walk = mixer.clipAction(clip(seed % 2 ? 'Walk_Formal_Loop' : 'Walk_Loop'));
    [idle, walk].forEach(action => { action.setLoop(LoopRepeat, Infinity); action.play(); });
    walk.setEffectiveWeight(0);
    return { root, mixer, idle, walk };
  }, [body, parts, animations, seed, tint, look]);
  useEffect(() => () => { rig.mixer.stopAllAction(); }, [rig]);
  return rig;
}

files.forEach(file => useGLTF.preload(`${base}${file}.glb`, false, true));
useGLTF.preload(`${base}humans-animations.glb`, false, true);
