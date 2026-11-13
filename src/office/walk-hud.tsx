import { useEffect, useRef, useState } from 'react';
import type { Place } from '../data/city';
import { playerPose } from '../world/player-pose';
import './office.css';

const reach = 6.5; // metres from a building's centre at which it can be used

/** While walking the city: the controls, always visible, and what pressing E does when you stand by a
 * building (talk to its agent, or open it). The nearest place is checked a few times a second from the
 * walker's pose, without re-rendering every frame. */
export function WalkHud({ places, onUse }: { places: Place[]; onUse: (place: Place) => void }) {
  const [near, setNear] = useState<Place | null>(null);
  const nearRef = useRef<Place | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      let best: Place | null = null, distance = reach;
      for (const place of places) {
        const d = Math.hypot(place.position[0] - playerPose.x, place.position[2] - playerPose.z);
        if (d < distance) { best = place; distance = d; }
      }
      if (best?.id !== nearRef.current?.id) { nearRef.current = best; setNear(best); }
    }, 200);
    return () => clearInterval(timer);
  }, [places]);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.metaKey || event.ctrlKey || event.altKey || !nearRef.current) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (document.pointerLockElement) document.exitPointerLock();
      onUse(nearRef.current);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [onUse]);
  const verb = near?.kind === 'profile' || near?.id === 'library' ? `Hablar con ${near.character ?? near.name}` : near ? `Abrir ${near.name}` : '';
  return <div className="walk-hud" aria-live="polite">
    <ul className="walk-keys" aria-label="Controles del paseo">
      <li><kbd>↑</kbd><kbd>W</kbd> avanzar</li><li><kbd>↓</kbd><kbd>S</kbd> retroceder</li>
      <li><kbd>←</kbd><kbd>→</kbd> girar</li><li><kbd>A</kbd><kbd>D</kbd> de lado</li>
      <li>ratón o arrastrar: mirar</li><li><kbd>E</kbd> usar</li><li><kbd>Esc</kbd> salir</li>
    </ul>
    {near && <button className="walk-use" onClick={() => onUse(near)}><kbd>E</kbd> {verb}</button>}
  </div>;
}
