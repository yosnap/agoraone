// Positions for the brain's graph: a force layout computed once, in the browser, with no model involved.
// Deterministic (seeded by each note's id), so the same brain always looks the same. Notes start around
// their top-level folder, links pull, everything near pushes (a spatial grid keeps it linear per step).

export type LayoutEdge = { a: number; b: number; weight: number };

const IDEAL = 4;          // preferred distance between linked notes
const CELL = IDEAL * 2.5; // repulsion only reaches the neighbouring grid cells
const STEPS = 140;

function seeded(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return () => { hash = Math.imul(hash ^ (hash >>> 15), 2246822507); hash = Math.imul(hash ^ (hash >>> 13), 3266489909); return ((hash ^= hash >>> 16) >>> 0) / 4294967296; };
}

/** Points spread evenly over a sphere (golden spiral), one per group. */
function sphere(count: number, radius: number) {
  return Array.from({ length: count }, (_, index) => {
    const y = count === 1 ? 0 : 1 - (index / (count - 1)) * 2, ring = Math.sqrt(1 - y * y), turn = index * Math.PI * (3 - Math.sqrt(5));
    return [Math.cos(turn) * ring * radius, y * radius, Math.sin(turn) * ring * radius];
  });
}

export function layoutGraph(nodes: { id: string; folder: string }[], edges: LayoutEdge[]): Float32Array {
  const count = nodes.length;
  const position = new Float32Array(count * 3);
  if (!count) return position;
  const groups = [...new Set(nodes.map(node => node.folder.split('/')[0]))].sort();
  const spread = Math.max(8, Math.cbrt(count) * IDEAL * 1.4);
  const centres = sphere(groups.length, groups.length > 1 ? spread : 0);
  const home = nodes.map(node => centres[groups.indexOf(node.folder.split('/')[0])]);
  nodes.forEach((node, index) => {
    const random = seeded(node.id);
    for (let axis = 0; axis < 3; axis++) position[index * 3 + axis] = home[index][axis] + (random() - 0.5) * spread * 0.5;
  });
  const shift = new Float32Array(count * 3);
  let temperature = spread * 0.2;
  for (let step = 0; step < STEPS; step++) {
    shift.fill(0);
    const grid = new Map<string, number[]>();
    const cellOf = (index: number) => [0, 1, 2].map(axis => Math.floor(position[index * 3 + axis] / CELL));
    for (let index = 0; index < count; index++) {
      const key = cellOf(index).join(',');
      const cell = grid.get(key);
      if (cell) cell.push(index); else grid.set(key, [index]);
    }
    for (let index = 0; index < count; index++) {
      const [cx, cy, cz] = cellOf(index);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const other of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (other <= index) continue;
          let x = position[index * 3] - position[other * 3], y = position[index * 3 + 1] - position[other * 3 + 1], z = position[index * 3 + 2] - position[other * 3 + 2];
          let distance = Math.hypot(x, y, z);
          if (distance > CELL) continue;
          if (distance < 0.01) { x = 0.01 * ((index % 3) - 1 || 1); y = 0.01; z = 0; distance = Math.hypot(x, y, z); }
          const force = (IDEAL * IDEAL) / distance / distance;
          shift[index * 3] += x * force; shift[index * 3 + 1] += y * force; shift[index * 3 + 2] += z * force;
          shift[other * 3] -= x * force; shift[other * 3 + 1] -= y * force; shift[other * 3 + 2] -= z * force;
        }
      }
    }
    for (const { a, b, weight } of edges) {
      const x = position[a * 3] - position[b * 3], y = position[a * 3 + 1] - position[b * 3 + 1], z = position[a * 3 + 2] - position[b * 3 + 2];
      const force = (Math.hypot(x, y, z) / IDEAL) * weight * 0.5;
      shift[a * 3] -= x * force; shift[a * 3 + 1] -= y * force; shift[a * 3 + 2] -= z * force;
      shift[b * 3] += x * force; shift[b * 3 + 1] += y * force; shift[b * 3 + 2] += z * force;
    }
    for (let index = 0; index < count; index++) {
      for (let axis = 0; axis < 3; axis++) shift[index * 3 + axis] += (home[index][axis] - position[index * 3 + axis]) * 0.03;
      const length = Math.hypot(shift[index * 3], shift[index * 3 + 1], shift[index * 3 + 2]);
      const scale = length > temperature ? temperature / length : 1;
      for (let axis = 0; axis < 3; axis++) position[index * 3 + axis] += shift[index * 3 + axis] * scale;
    }
    temperature *= 0.97;
  }
  // Centred on the origin, where the camera looks and turns.
  for (let axis = 0; axis < 3; axis++) {
    let sum = 0;
    for (let index = 0; index < count; index++) sum += position[index * 3 + axis];
    for (let index = 0; index < count; index++) position[index * 3 + axis] -= sum / count;
  }
  return position;
}
