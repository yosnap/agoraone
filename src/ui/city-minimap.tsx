import { useEffect, useRef } from 'react';
import { cityExtent, type Place } from '../data/city';
import { avenue, cityGrid, street } from '../world/city-layout';
import { playerPose } from '../world/player-pose';
import './city-minimap.css';

// Plot footprint on the map, the same box the walk collides with.
const plot = { halfX: 2.8, halfZ: 2.2 };

/** Top-down map of the city during the walk: streets, buildings by colour, and where you are and face. */
export function CityMinimap({ places, onSelect }: { places: Place[]; onSelect: (id: string) => void }) {
  const extent = cityExtent(places);
  const { avenues, streets } = cityGrid(places, extent);
  const marker = useRef<SVGGElement>(null);
  // Follows the walker every frame by moving one SVG node, without re-rendering React.
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      const x = Math.max(-extent, Math.min(extent, playerPose.x)), z = Math.max(-extent, Math.min(extent, playerPose.z));
      marker.current?.setAttribute('transform', `translate(${x} ${z}) rotate(${playerPose.heading * 180 / Math.PI})`);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [extent]);
  const span = extent * 2;
  return <figure className="city-minimap" aria-label="Minimapa de la ciudad">
    <svg viewBox={`${-extent} ${-extent} ${span} ${span}`} role="img" aria-labelledby="minimap-title">
      <title id="minimap-title">Plano de la ciudad con tu posición</title>
      <rect className="minimap-ground" x={-extent} y={-extent} width={span} height={span} rx={2}/>
      {avenues.map(z => <rect key={`a${z}`} className="minimap-road" x={-extent + 1} y={z - avenue.width / 2} width={span - 2} height={avenue.width}/>)}
      {streets.map(x => <rect key={`s${x}`} className="minimap-road" x={x - street.width / 2} y={-extent + 1} width={street.width} height={span - 2}/>)}
      {places.map(place => <rect key={place.id} className="minimap-plot" x={place.position[0] - plot.halfX} y={place.position[2] - plot.halfZ} width={plot.halfX * 2} height={plot.halfZ * 2} rx={0.6}
        style={{ fill: place.color }} onClick={() => onSelect(place.id)}><title>{place.name}</title></rect>)}
      <g ref={marker} className="minimap-you" aria-hidden="true">
        <path className="minimap-cone" d="M0 0 L-4.5 -9 A10 10 0 0 1 4.5 -9 Z"/>
        <path className="minimap-arrow" d="M0 -2.4 L1.8 1.8 L0 0.9 L-1.8 1.8 Z"/>
      </g>
    </svg>
    <figcaption>Tú · <span aria-hidden="true">↑</span> norte</figcaption>
  </figure>;
}
