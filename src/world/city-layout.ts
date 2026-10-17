import type { Place } from '../data/city';

// Street grid derived from building positions, so any catalog size gets coherent roads.
// Plots measure 5.8 × 4.8; characters walk on the sidewalk in front (z + 3).
export const avenue = { offset: 5, width: 2.6 };
export const street = { offset: 4.5, width: 1.8 };
/** Height of raised sidewalks; walkers, lamps and benches stand on top of it. */
export const curb = 0.12;

export function cityGrid(places: Place[], extent: number) {
  const xs = [...new Set(places.map(place => place.position[0]))].sort((a, b) => a - b);
  const zs = [...new Set(places.map(place => place.position[2]))].sort((a, b) => a - b);
  const span = extent * 2 - 1;
  const avenues = zs.length ? [zs[0] - avenue.offset, ...zs.map(z => z + avenue.offset)] : [];
  const streets = xs.length ? [...new Set(xs.flatMap(x => [x - street.offset, x + street.offset]))] : [];
  return { xs, zs, span, avenues: avenues.filter(z => Math.abs(z) < extent - 1), streets: streets.filter(x => Math.abs(x) < extent - 1) };
}
