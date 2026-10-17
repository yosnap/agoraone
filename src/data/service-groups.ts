import type { HermesCatalog, HermesProfile } from '../../shared/hermes-catalog';

// A visual grouping by name, NOT an assertion that profiles share endpoints/auth.
export function serviceGroups(catalog: HermesCatalog | null) {
  const groups = new Map<string, { id: string; name: string; bindings: { profile: HermesProfile; server: NonNullable<HermesProfile['mcp']>[number] }[] }>();
  for (const profile of catalog?.profiles || []) for (const server of profile.mcp || []) {
    const id = `service-${encodeURIComponent(server.name)}`;
    if (!groups.has(id)) groups.set(id, { id, name: server.name, bindings: [] });
    groups.get(id)!.bindings.push({ profile, server });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
