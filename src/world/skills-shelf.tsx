import { useEffect, useState } from 'react';
import { listProfileSkills } from '../api/client';
import { folderColor } from '../ui/vault-folders';
import { WorldLabel } from './world-label';
import { SurfaceMaterial } from './surfaces';

// The profile's real skills as books on a stand-alone shelf, coloured by category like the vault's
// tree. Hovering shows the skill's name; clicking (or the sign) opens the skills sheet. Read-only:
// nothing here reaches the model and no skill is changed.
type ShownSkill = { id: string; name: string; category: string };
const rows = [0.5, 1.3, 2.1, 2.9], perRow = 8, maxBooks = 32;

export function SkillsShelf({ x, z, profileId, onShelf }: { x: number; z: number; profileId: string; onShelf: () => void }) {
  const [skills, setSkills] = useState<ShownSkill[] | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const point = (id: string | null) => { setHoverId(id); document.body.style.cursor = id === null ? '' : 'pointer'; };
  useEffect(() => {
    let live = true;
    setSkills(null); setHoverId(null);
    listProfileSkills(profileId)
      .then(data => { if (live) setSkills(data.skills.map(skill => ({ id: skill.id, name: skill.name, category: skill.category }))); })
      .catch(() => { if (live) setSkills([]); });
    return () => { live = false; };
  }, [profileId]);
  useEffect(() => () => { document.body.style.cursor = ''; }, []);
  const books = (skills ?? []).slice(0, maxBooks);
  const hover = hoverId === null ? -1 : books.findIndex(skill => skill.id === hoverId);
  const spot = (index: number) => ({ x: -1.05 + (index % perRow) * 0.26, y: rows[Math.floor(index / perRow)] });
  const more = (skills?.length ?? 0) - books.length;
  return <group position={[x, 0, z]} rotation={[0, Math.PI, 0]}>
    <mesh position={[0, 1.6, -0.05]} castShadow receiveShadow><boxGeometry args={[2.7, 3.3, 0.5]}/><SurfaceMaterial kind="wood" color="#5d4632"/></mesh>
    <mesh position={[0, 3.32, 0.12]} castShadow><boxGeometry args={[2.9, 0.12, 0.75]}/><SurfaceMaterial kind="wood" color="#4a3726"/></mesh>
    {rows.map(y => <mesh key={y} position={[0, y - 0.28, 0.32]} receiveShadow><boxGeometry args={[2.62, 0.06, 0.4]}/><SurfaceMaterial kind="wood" color="#a88b60"/></mesh>)}
    {books.map((skill, index) => {
      const { x: bx, y } = spot(index), height = 0.36 + ((index * 7) % 4) * 0.04, lit = hover === index;
      return <mesh key={skill.id} position={[bx, y - 0.25 + height / 2, lit ? 0.45 : 0.35]} rotation={[0, 0, (index % perRow === perRow - 1 ? 0.08 : 0)]}
        onPointerOver={event => { event.stopPropagation(); point(skill.id); }} onPointerOut={() => point(null)}
        onClick={event => { event.stopPropagation(); point(null); onShelf(); }}>
        <boxGeometry args={[0.18, height, 0.3]}/>
        <meshStandardMaterial color={folderColor(skill.category)} emissive={lit ? '#ffd38a' : '#000000'} emissiveIntensity={lit ? 0.35 : 0} roughness={0.7}/>
      </mesh>;
    })}
    {hover >= 0 && <WorldLabel position={[spot(hover).x, spot(hover).y + 0.45, 0.5]} distanceFactor={7}>
      <span className="place-label book-label">{books[hover].name}{books[hover].category ? ` · ${books[hover].category}` : ''}</span>
    </WorldLabel>}
    <WorldLabel position={[0, 3.75, 0.4]} distanceFactor={10}>
      <button className="place-label" onClick={onShelf}>
        {skills === null ? 'Leyendo sus skills…' : skills.length ? `Skills · ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${more > 0 ? ` · ${more} más en la ficha` : ''}` : 'Todavía no hay skills'}
      </button>
    </WorldLabel>
  </group>;
}
