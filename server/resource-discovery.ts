import { createHash } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readHermesFile, redact } from './hermes-safe-read';
import type { HermesCatalog, HermesProfile } from '../shared/hermes-catalog';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
// Mirrors the installed Hermes _parse_boolish; absent/unparseable means enabled.
function enabled(value: unknown) {
  if (typeof value === 'boolean' || typeof value === 'number') return !!value;
  return !(typeof value === 'string' && ['false', '0', 'no', 'off'].includes(value.trim().toLowerCase()));
}
export function mcpMetadata(profileId: string, config: Record<string, unknown>): NonNullable<HermesProfile['mcp']> {
  if (!config.mcp_servers || typeof config.mcp_servers !== 'object' || Array.isArray(config.mcp_servers)) return [];
  return Object.entries(config.mcp_servers).slice(0, 100).flatMap(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const server = value as Record<string, unknown>;
    // Explicit allowlist. Never expose commands, args, URLs, headers, env or auth.
    return [{ id: `mcp-${hash(profileId + ':' + name)}`, name: redact(name, 100), enabled: enabled(server.enabled),
      transport: server.url ? 'http' as const : server.command ? 'stdio' as const : 'unknown' as const, connection: 'unverified' as const }];
  });
}

export function obsidianRegistryPath(): string | null {
  if (process.env.AGORA_OBSIDIAN_REGISTRY) return process.env.AGORA_OBSIDIAN_REGISTRY;
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/obsidian/obsidian.json');
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'obsidian/obsidian.json');
  if (process.platform === 'linux') return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'obsidian/obsidian.json');
  return null;
}
export function obsidianVaults(registry = obsidianRegistryPath()): { vaults: NonNullable<HermesCatalog['vaults']>; warnings: string[] } {
  if (!registry) return { vaults: [], warnings: [] };
  try {
    const root = realpathSync(dirname(registry));
    const data = JSON.parse(readHermesFile(root, join(root, basename(registry)), 128 * 1024).toString());
    if (!data.vaults || typeof data.vaults !== 'object' || Array.isArray(data.vaults)) throw new Error('Invalid registry');
    const paths = new Set<string>();
    const vaults: NonNullable<HermesCatalog['vaults']> = [];
    for (const value of Object.values(data.vaults).slice(0, 100)) {
      const path = (value as { path?: unknown } | null)?.path;
      if (typeof path !== 'string' || !isAbsolute(path) || paths.has(path)) continue;
      paths.add(path);
      let available = false;
      try { available = statSync(path).isDirectory(); } catch { /* removable/unavailable volume */ }
      // Only stat the root; do not enumerate/read notes, attachments or .obsidian.
      vaults.push({ id: `vault-${hash(path)}`, name: redact(basename(path), 100), available, source: 'obsidian-registry' });
    }
    return { vaults, warnings: [] };
  } catch (error) {
    return { vaults: [], warnings: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['No se pudo leer el registro de Obsidian; no se han explorado carpetas alternativas.'] };
  }
}
