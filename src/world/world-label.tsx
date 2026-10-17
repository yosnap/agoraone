import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Vector3 } from 'three';

// Own DOM container, detached only after its React root has finished unmounting.
// Avoid synchronously unmounting nested DOM roots while R3F changes scenes.
export function WorldLabel({ position, children, distanceFactor = 20 }: {
  position: [number, number, number]; children: ReactNode; distanceFactor?: number;
}) {
  const anchor = useRef<Group>(null);
  const element = useRef<HTMLDivElement | null>(null);
  const root = useRef<Root | null>(null);
  const world = useRef(new Vector3());
  const projected = useRef(new Vector3());
  const { gl, camera, size } = useThree();
  useEffect(() => {
    const container = document.createElement('div');
    Object.assign(container.style, { position: 'absolute', left: '0', top: '0', zIndex: '5', display: 'none' });
    gl.domElement.parentElement!.appendChild(container);
    const domRoot = createRoot(container);
    element.current = container; root.current = domRoot;
    return () => {
      element.current = null; root.current = null;
      queueMicrotask(() => { domRoot.unmount(); container.remove(); });
    };
  }, [gl]);
  useEffect(() => { root.current?.render(children); }, [children]);
  useFrame(() => {
    if (!anchor.current || !element.current) return;
    anchor.current.getWorldPosition(world.current);
    projected.current.copy(world.current).project(camera);
    const visible = projected.current.z > -1 && projected.current.z < 1 && Math.abs(projected.current.x) < 1.15 && Math.abs(projected.current.y) < 1.15;
    element.current.style.display = visible ? 'block' : 'none';
    const scale = Math.max(0.6, Math.min(1.3, distanceFactor / camera.position.distanceTo(world.current)));
    element.current.style.transform = `translate(${(projected.current.x + 1) * size.width / 2}px, ${(1 - projected.current.y) * size.height / 2}px) translate(-50%, -50%) scale(${scale})`;
  });
  return <group ref={anchor} position={position}/>;
}
