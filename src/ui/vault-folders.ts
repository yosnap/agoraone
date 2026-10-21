// The vault's folders as a browsable tree, each with a stable colour from the same palette
// the 3D room uses for its books, so the panel and the shelves read like the same library.

export type FolderNode = { name: string; path: string; count: number; children: FolderNode[] };

const byName = (a: string, b: string) => a.localeCompare(b, 'es');
const palette = ['#8c79b8', '#b0784f', '#5f8a7d', '#c2a35a', '#7b6290', '#a8605e', '#4f7192', '#8f9a5a'];
const neutral = '#9a93a8';

/** A deterministic colour for a folder path; root notes use a neutral tone. */
export function folderColor(path: string) {
  if (!path) return neutral;
  let hash = 0;
  for (let index = 0; index < path.length; index++) hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  return palette[hash % palette.length];
}

/** Folders of the listing as a tree; each node counts the notes it holds at any depth. */
export function folderTree(notes: { folder: string }[]): FolderNode[] {
  type Building = { name: string; count: number; kids: Map<string, Building> };
  const top = new Map<string, Building>();
  for (const { folder } of notes) {
    if (!folder) continue;
    let level = top;
    for (const name of folder.split('/')) {
      let node = level.get(name);
      if (!node) { node = { name, count: 0, kids: new Map() }; level.set(name, node); }
      node.count += 1;
      level = node.kids;
    }
  }
  const render = (node: Building, path: string): FolderNode => ({
    name: node.name, path, count: node.count,
    children: [...node.kids.values()].sort((a, b) => byName(a.name, b.name)).map(kid => render(kid, `${path}/${kid.name}`)),
  });
  return [...top.values()].sort((a, b) => byName(a.name, b.name)).map(node => render(node, node.name));
}
