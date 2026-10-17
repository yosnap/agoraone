import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Euler, Vector3 } from 'three';
import { cityExtent, type Place } from '../data/city';
import type { Obstacle } from './profile-decor';
import { cityGrid } from './city-layout';

// `room` identifies the current interior (camera resets when it changes); `obstacles` are its collision boxes.
export function Navigation({ places, firstPerson, blocked, inside = false, room = '', obstacles = [] }: { places: Place[]; firstPerson: boolean; blocked: boolean; inside?: boolean; room?: string; obstacles?: Obstacle[] }) {
  const extent = cityExtent(places);
  // Outdoor walk starts on the street closest to the centre, looking down it.
  const streets = cityGrid(places, extent).streets;
  const spawnX = streets.reduce((best, x) => Math.abs(x) < Math.abs(best) ? x : best, streets[0] ?? 0);
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>());
  const direction = useRef(new Vector3());
  const right = useRef(new Vector3());
  useEffect(() => {
    if (inside) camera.position.set(0, 1.7, 5);
    else if (firstPerson) camera.position.set(spawnX, 1.7, extent - 2);
    else camera.position.set(extent * 1.35, extent * 1.4, extent * 1.7);
    camera.lookAt(firstPerson && !inside ? spawnX : 0, firstPerson ? 1.7 : 0, 0);
    keys.current.clear();
    if (document.pointerLockElement) document.exitPointerLock();
  }, [camera, firstPerson, inside, room, extent, spawnX]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (document.pointerLockElement === gl.domElement || document.activeElement === gl.domElement) keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const clear = () => keys.current.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', clear); document.addEventListener('pointerlockchange', clear);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear); document.removeEventListener('pointerlockchange', clear); };
  }, [gl]);
  useEffect(() => { if (blocked && document.pointerLockElement) document.exitPointerLock(); }, [blocked]);
  useEffect(() => {
    const rotation = new Euler(0, 0, 0, 'YXZ');
    const look = (event: MouseEvent) => {
      const locked = document.pointerLockElement === gl.domElement;
      const dragging = document.activeElement === gl.domElement && event.buttons === 1;
      if (!firstPerson || blocked || (!locked && !dragging)) return;
      rotation.setFromQuaternion(camera.quaternion);
      rotation.y -= event.movementX * 0.002;
      rotation.x = Math.max(-1.4, Math.min(1.4, rotation.x - event.movementY * 0.002));
      camera.quaternion.setFromEuler(rotation);
    };
    document.addEventListener('mousemove', look);
    return () => document.removeEventListener('mousemove', look);
  }, [firstPerson, blocked, camera, gl]);
  useFrame((_, delta) => {
    if (!firstPerson || blocked || (document.pointerLockElement !== gl.domElement && document.activeElement !== gl.domElement)) return;
    const forward = Number(keys.current.has('KeyW')) - Number(keys.current.has('KeyS'));
    const sideways = Number(keys.current.has('KeyD')) - Number(keys.current.has('KeyA'));
    camera.getWorldDirection(direction.current); direction.current.y = 0; direction.current.normalize();
    right.current.crossVectors(direction.current, camera.up).normalize();
    const next = camera.position.clone();
    const speed = Math.min(delta, 0.05) * 5 / Math.max(1, Math.hypot(forward, sideways));
    next.addScaledVector(direction.current, forward * speed).addScaledVector(right.current, sideways * speed);
    next.x = Math.max(inside ? -6.5 : -extent + 1, Math.min(inside ? 6.5 : extent - 1, next.x));
    next.z = Math.max(inside ? -7.5 : -extent + 1, Math.min(inside ? 7.5 : extent - 1, next.z));
    const collides = inside
      ? obstacles.some(p => Math.abs(next.x - p.x) < p.halfX && Math.abs(next.z - p.z) < p.halfZ)
      : places.some(p => Math.abs(next.x - p.position[0]) < 2.8 && Math.abs(next.z - p.position[2]) < 2.2);
    if (!collides) camera.position.copy(next);
  });
  return firstPerson ? null
    : <OrbitControls makeDefault target={[0, 0, 0]} minDistance={14} maxDistance={extent * 5} maxPolarAngle={Math.PI / 2.3}/>;
}
