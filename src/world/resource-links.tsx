import { Line } from '@react-three/drei';
import type { Place } from '../data/city';

export function ResourceLinks({ places, selected }: { places: Place[]; selected: string | null }) {
  if (!selected) return null;
  return <group>{places.flatMap(resource => (resource.relatedIds || []).flatMap(id => {
    if (resource.id !== selected && id !== selected) return [];
    const profile = places.find(place => place.id === id);
    if (!profile) return [];
    const from = resource.position, to = profile.position;
    return <Line key={`${resource.id}-${id}`} points={[[from[0], 0.35, from[2]], [from[0], 0.35, to[2]], [to[0], 0.35, to[2]]]} color="#f7e9ae" lineWidth={2} dashed dashSize={0.25} gapSize={0.18}/>;
  }))}</group>;
}
