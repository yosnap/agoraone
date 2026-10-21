import { useEffect, useState } from 'react';
import type { VaultShelf } from '../data/use-vault-notes';
import { folderColor } from '../ui/vault-folders';
import { WorldLabel } from './world-label';
import { SurfaceMaterial } from './surfaces';

// A shelf for one top-level folder: each book is a real note (up to 36), coloured by its folder,
// with the same stable colour as the panel's folder tree and shelves.
// Pointing at a book shows its title; clicking opens it as a book. Contents are only read on open.
const rows = [0.5, 1.3, 2.1, 2.9], perRow = 9;

export function Shelf({ x, z, shelf, onShelf, onBook }: { x: number; z: number; shelf: VaultShelf; onShelf: () => void; onBook: (id: string) => void }) {
  // Hover is kept by note id, so a refreshed listing never labels the wrong book.
  const [hoverId, setHoverId] = useState<string | null>(null);
  const point = (id: string | null) => { setHoverId(id); document.body.style.cursor = id === null ? '' : 'pointer'; };
  useEffect(() => () => { document.body.style.cursor = ''; }, []);
  const hover = hoverId === null ? -1 : shelf.books.findIndex(book => book.id === hoverId);
  const spot = (index: number) => ({ x: -1.05 + (index % perRow) * 0.26, y: rows[Math.floor(index / perRow)] });
  const more = shelf.notes - shelf.books.length;
  return <group position={[x, 0, z]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}>
    <mesh position={[0, 1.6, -0.05]} castShadow receiveShadow><boxGeometry args={[2.7, 3.3, 0.5]}/><SurfaceMaterial kind="wood" color="#5d4632"/></mesh>
    <mesh position={[0, 3.32, 0.12]}><boxGeometry args={[2.9, 0.12, 0.75]}/><SurfaceMaterial kind="wood" color="#4a3726"/></mesh>
    {rows.map(y => <mesh key={y} position={[0, y - 0.28, 0.32]} receiveShadow><boxGeometry args={[2.62, 0.06, 0.4]}/><SurfaceMaterial kind="wood" color="#a88b60"/></mesh>)}
    {shelf.books.map((book, index) => {
      const { x: bx, y } = spot(index), height = 0.36 + ((index * 7) % 4) * 0.04, lit = hover === index;
      return <mesh key={book.id} position={[bx, y - 0.25 + height / 2, lit ? 0.45 : 0.35]} rotation={[0, 0, (index % 9 === 8 ? 0.08 : 0)]}
        onPointerOver={event => { event.stopPropagation(); point(book.id); }} onPointerOut={() => point(null)}
        onClick={event => { event.stopPropagation(); point(null); if (book.readable) onBook(book.id); else onShelf(); }}>
        <boxGeometry args={[0.18, height, 0.3]}/>
        <meshStandardMaterial color={book.readable ? folderColor(book.folder) : '#5a5560'} emissive={lit ? '#ffd38a' : '#000000'} emissiveIntensity={lit ? 0.35 : 0} roughness={0.7}/>
      </mesh>;
    })}
    {hover >= 0 && <WorldLabel position={[spot(hover).x, spot(hover).y + 0.45, 0.5]} distanceFactor={7}>
      <span className="place-label book-label">{shelf.books[hover].title}{!shelf.books[hover].readable && ' · demasiado grande'}</span>
    </WorldLabel>}
    <WorldLabel position={[0, 3.75, 0.4]} distanceFactor={10}><button className="place-label" onClick={onShelf}>{shelf.folder || 'Notas sueltas'} · {shelf.notes} {shelf.notes === 1 ? 'nota' : 'notas'}{more > 0 ? ` · ${more} más en la ficha` : ''}</button></WorldLabel>
  </group>;
}
