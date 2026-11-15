// Where the graph's spheres travel when something is lit (a search, a picked note, what Watson reads):
// the lit notes gather into a constellation around a focus point, the best match at its centre, and the
// rest step aside. Pure geometry, computed in the browser; no model is involved.

export type Motion = { target: Float32Array; focus: [number, number, number]; synapses: [number, number][]; reach: number };

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const MAX_GATHERED = 60;

/** `order`: indexes of the lit nodes, best first. `edges`: real connections, as node index pairs. */
export function gather(base: Float32Array, order: number[], edges: [number, number][]): Motion {
  if (!order.length) return { target: base, focus: [0, 0, 0], synapses: [], reach: 0 };
  const gathered = order.slice(0, MAX_GATHERED);
  const centre = [0, 1, 2].map(axis => gathered.reduce((sum, node) => sum + base[node * 3 + axis], 0) / gathered.length);
  // Half-way to the origin, so the constellation stays in front of the camera.
  const focus: [number, number, number] = [centre[0] * 0.5, centre[1] * 0.5, centre[2] * 0.5];
  // The constellation's size, and a clear space around it: everything else steps out of that sphere.
  const reach = 4 + Math.sqrt(gathered.length) * 3;
  const clear = reach + 6;
  const target = new Float32Array(base.length);
  for (let index = 0; index < base.length; index += 3) {
    const x = base[index] - focus[0], y = base[index + 1] - focus[1], z = base[index + 2] - focus[2];
    const distance = Math.hypot(x, y, z) || 1;
    const away = Math.max(distance * 1.15, clear + distance * 0.6) / distance;
    target[index] = focus[0] + x * away; target[index + 1] = focus[1] + y * away; target[index + 2] = focus[2] + z * away;
  }
  gathered.forEach((node, rank) => {
    const radius = rank === 0 ? 0 : 4 + Math.sqrt(rank) * 3;
    const y = gathered.length < 3 ? 0 : 1 - (rank / (gathered.length - 1)) * 2, ring = Math.sqrt(Math.max(0, 1 - y * y)), turn = rank * GOLDEN;
    const offset = [Math.cos(turn) * ring, y, Math.sin(turn) * ring];
    for (let axis = 0; axis < 3; axis++) target[node * 3 + axis] = focus[axis] + offset[axis] * radius;
  });
  const inside = new Set(gathered);
  const seen = new Set<string>();
  const synapses: [number, number][] = [];
  const add = (a: number, b: number) => { const key = a < b ? `${a}-${b}` : `${b}-${a}`; if (a !== b && !seen.has(key)) { seen.add(key); synapses.push([a, b]); } };
  for (const [a, b] of edges) if (inside.has(a) && inside.has(b)) add(a, b);
  for (const node of gathered.slice(1)) add(gathered[0], node);
  return { target, focus, synapses, reach };
}
