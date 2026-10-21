import type { HermesCatalog } from '../../shared/hermes-catalog';
import { profileStyle, type BuildingStyle } from './building-style';
import { serviceGroups } from './service-groups';
export type Place = {
  id: string; resourceId: string; name: string; character: string; color: string;
  position: [number, number, number]; description: string;
  kind?: 'profile' | 'space' | 'vault' | 'service';
  relatedIds?: string[];
  buildingStyle?: BuildingStyle;
};
// These IDs are logical resources, deliberately not paths on the host filesystem.
export const places: Place[] = [
  { id: 'library', resourceId: 'library-lobby', name: 'Biblioteca', character: 'Luma', color: '#e7bd6a', position: [-7, 0, -4], description: 'Un lugar para tus ideas y lecturas.' },
];

export function catalogPlaces(catalog: HermesCatalog | null): Place[] {
  const used = new Set<BuildingStyle>();
  const entities: Omit<Place, 'position'>[] = [
    ...places,
    ...(catalog?.profiles || []).map(profile => ({ id: profile.id, resourceId: profile.id, name: `Perfil · ${profile.label}`, character: profile.label,
      color: profile.color, description: profile.description, buildingStyle: profileStyle(profile.name, profile.description, used), kind: 'profile' as const })),
    ...(catalog?.spaces || []).filter(space => space.source !== 'workspace').map(space => ({ id: space.id, resourceId: space.id, name: `Espacio · ${space.label}`, character: '',
      color: '#a0b5a4', description: space.description, relatedIds: space.profileIds, buildingStyle: 'archive' as const, kind: 'space' as const })),
    ...(catalog?.vaults || []).map(vault => ({ id: vault.id, resourceId: vault.id, name: `Obsidian · ${vault.name}`, character: '',
      color: '#b5a1dc', description: 'Vault local registrado en Obsidian. Sus notas se pueden leer y buscar, y editar o crear con confirmación y copia previa; solo se envían al modelo si las consultas.', buildingStyle: 'vault' as const, kind: 'vault' as const })),
    ...(serviceGroups(catalog).length ? [{ id: 'mcp-center', resourceId: 'mcp-center', name: 'Centro de integraciones', character: '',
      color: '#79b9c8', description: 'Entra para explorar los MCP y sus herramientas por perfil.',
      relatedIds: (catalog?.profiles || []).filter(profile => profile.mcp?.length).map(profile => profile.id), buildingStyle: 'service' as const, kind: 'service' as const }] : []),
  ];
  const columns = Math.max(2, Math.ceil(Math.sqrt(entities.length)));
  const rows = Math.ceil(entities.length / columns);
  return entities.map((place, i) => ({ ...place, position: [(i % columns - (columns - 1) / 2) * 9, 0, (Math.floor(i / columns) - (rows - 1) / 2) * 10] }));
}

export function servicePlaces(catalog: HermesCatalog | null): Place[] {
  return serviceGroups(catalog).map(service => ({ id: service.id, resourceId: service.id, name: `MCP · ${service.name}`, character: '',
    color: '#79b9c8', description: 'Herramientas y configuración por perfil. Conexión actual no comprobada.', kind: 'service', position: [0, 0, 0] }));
}

export function cityExtent(places: Place[]) { return Math.max(18, ...places.map(p => Math.max(Math.abs(p.position[0]), Math.abs(p.position[2])) + 8)); }

export const lumaBinding = { characterId: 'luma', agentId: 'luma', contextId: 'library-lobby', profileId: null, botId: null } as const;
