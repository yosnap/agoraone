import { existsSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { HermesCatalog, HermesProfile, HermesFile, HermesSpace } from '../shared/hermes-catalog';
import { hermesLocation } from './hermes-location';
import { readHermesFile, readMetadata, redact } from './hermes-safe-read';
import { isHiddenMarker, maskSecrets, revealSecrets } from './secret-lines';
import { readHermesDatabase } from './hermes-database';
import { mcpMetadata } from './resource-discovery';
import { readMcpTools } from './mcp-tools';

const markers = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'];
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const colors = ['#81b8cf', '#aa9be0', '#8dbb98', '#d98f75', '#e7bd6a'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
/** Revision of an identity file; the profile editor and its Python writer compute the same value. */
export const fileRevision = digest;

export class HermesDiscovery {
  private cached?: HermesCatalog;
  private cachedAt = 0;
  private location: ReturnType<typeof hermesLocation>;
  constructor(location = hermesLocation()) { this.location = location; }

  private root() { return realpathSync(this.location.root); }
  private profileHome(root: string, name: string) {
    if (name !== 'default' && !namePattern.test(name)) throw new Error('Unknown profile');
    const home = name === 'default' ? root : join(root, 'profiles', name);
    if (realpathSync(home) !== home || !lstatSync(home).isDirectory()) throw new Error('Unknown profile');
    if (name !== 'default' && existsSync(join(root, 'profiles/.deleted', name))) throw new Error('Deleted profile');
    if (!markers.some(marker => existsSync(join(home, marker)))) throw new Error('Unknown profile');
    return home;
  }
  // Content is masked line by line unless the user explicitly asks to reveal it; the model only ever gets the masked text.
  private files(root: string, home: string, withContent = false, reveal = false): HermesFile[] {
    return (['SOUL.md', 'MEMORY.md', 'USER.md'] as const).map(name => {
      const file = name === 'SOUL.md' ? join(home, name) : join(home, 'memories', name);
      try {
        const data = readHermesFile(root, file);
        const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (!withContent) return { name, state: 'available', bytes: data.length, revision: digest(content) };
        const masked = maskSecrets(content);
        return { name, state: 'available', bytes: data.length, revision: digest(content), content: reveal ? revealSecrets(content) : masked.text, hidden: masked.hidden.length,
          // How many more characters the hidden lines take than their markers, so the editor counts like Hermes.
          hiddenChars: reveal ? 0 : [...content].length - [...masked.text].length };
      } catch { return { name, state: existsSync(file) ? 'unavailable' : 'missing' }; }
    });
  }
  detail(id: string, reveal = false) {
    const root = this.root();
    // Resolve against a fresh registry; removal/tombstoning revokes access immediately.
    const profile = this.scan(true).profiles.find(p => p.id === id);
    if (!profile) throw new Error('Unknown profile');
    const home = this.profileHome(root, profile.name);
    return { profile, files: this.files(root, home, true, reveal), limits: this.memoryLimits(root, home) };
  }
  /** Hermes' own caps for MEMORY.md and USER.md (memory.*_char_limit in the profile's config.yaml). */
  private memoryLimits(root: string, home: string) {
    let memory: Record<string, unknown> = {};
    try { memory = readMetadata(root, join(home, 'config.yaml')).memory ?? {}; } catch { /* Hermes defaults */ }
    const limit = (value: unknown, fallback: number) => Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
    return { 'MEMORY.md': limit(memory.memory_char_limit, 2200), 'USER.md': limit(memory.user_char_limit, 1375) };
  }
  /** Where one identity file of a profile lives, for the editor. The client only names the profile id and the file. */
  editTarget(id: string, name: HermesFile['name']) {
    const root = this.root();
    const profile = this.scan(true).profiles.find(p => p.id === id);
    if (!profile) throw new Error('Unknown profile');
    const home = this.profileHome(root, profile.name);
    return { root, path: name === 'SOUL.md' ? join(home, name) : join(home, 'memories', name), limit: name === 'SOUL.md' ? null : this.memoryLimits(root, home)[name], python: this.location.python };
  }
  /** Where to read activity from. Profiles come from the catalog; the client never names a path. */
  activityTargets() {
    const root = this.root();
    const profiles = this.scan().profiles.flatMap(profile => { try { return [{ id: profile.id, name: profile.name, home: this.profileHome(root, profile.name), mcp: profile.mcp?.map(server => server.name) }]; } catch { return []; } });
    return { root, profiles };
  }
  mcpTools(profileId: string, serverId: string) {
    const { root, home, server, config } = this.mcpServer(profileId, serverId);
    return readMcpTools(root, home, server, config);
  }
  /** The profile and server an opaque MCP id names, resolved against fresh config; never a path or name from the client. */
  mcpServer(profileId: string, serverId: string) {
    const root = this.root();
    const profile = this.scan(true).profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('Unknown profile');
    const home = this.profileHome(root, profile.name);
    const config = readMetadata(root, join(home, 'config.yaml'));
    for (const [name, value] of Object.entries(config.mcp_servers || {})) {
      if (mcpMetadata(profileId, { mcp_servers: { [name]: value } })[0]?.id === serverId)
        return { root, home, profile: profile.name, server: name, config: value as Record<string, unknown> };
    }
    throw new Error('Unknown MCP');
  }
  scan(force = false): HermesCatalog {
    if (!force && this.cached && Date.now() - this.cachedAt < 20000) return this.cached;
    const result: HermesCatalog = {
      schema: 1, state: 'missing', scannedAt: new Date().toISOString(),
      installation: { detected: false, version: null, source: this.location.source, compatibility: 'Lectura por capacidades; conversación aislada sujeta al contrato verificado de AIAgent, sin herramientas.' },
      profiles: [], spaces: [], warnings: [],
    };
    let root: string;
    try { root = this.root(); } catch { result.warnings.push('No se encuentra el directorio de datos de Hermes. Configura AGORA_HERMES_HOME si está en otra ubicación.'); return result; }
    try {
      const installation = realpathSync(this.location.installation);
      result.installation.detected = existsSync(join(installation, 'run_agent.py'));
      const metadata = readHermesFile(installation, join(installation, 'pyproject.toml'), 131072).toString();
      result.installation.version = metadata.match(/^version\s*=\s*["']([^"']+)/m)?.[1] || null;
    } catch { result.warnings.push('No se pudo comprobar la versión del código instalado; se muestran solo estructuras reconocidas.'); }
    let active = 'default';
    try { active = readHermesFile(root, join(root, 'active_profile'), 256).toString().trim(); } catch { /* no active marker */ }
    let names = ['default'];
    try { names.push(...readdirSync(join(root, 'profiles')).filter(name => name !== 'default' && namePattern.test(name)).sort()); } catch { /* single-profile installation */ }
    if (names.length > 100) result.warnings.push('Se muestran los primeros 100 perfiles.');
    const spaces = new Map<string, HermesSpace>();
    for (const name of names.slice(0, 100)) {
      let home: string;
      try { home = this.profileHome(root, name); } catch { continue; }
      const id = `profile-${digest(root + ':' + name)}`;
      let meta: Record<string, any> = {}, config: Record<string, any> = {};
      for (const [file, target] of [['profile.yaml', 'meta'], ['config.yaml', 'config']] as const) {
        if (!existsSync(join(home, file))) continue;
        try { const value = readMetadata(root, join(home, file)); if (target === 'meta') meta = value; else config = value; }
        catch { result.warnings.push(`Metadatos no legibles en el perfil ${name}.`); }
      }
      const bot = meta.ui_meta?.['hermes-bots'];
      const files = this.files(root, home);
      let soul = '';
      // The description shown without asking comes from SOUL with credential-like lines removed first.
      try { soul = redact(maskSecrets(readHermesFile(root, join(home, 'SOUL.md')).toString()).text.split('\n').filter(line => !isHiddenMarker(line)).join('\n'), 2000); } catch { /* optional identity */ }
      const heading = soul.match(/^#\s+(.+)$/m)?.[1]?.replace(/[*_`]/g, '').trim().slice(0, 100);
      const description = redact(meta.description || bot?.description, 700) || soul.replace(/^#+\s+.*$/gm, '').trim().slice(0, 500);
      const label = redact(meta.display_name || bot?.title, 100) || (name === 'default' ? heading || 'Hermes principal' : name);
      const profile: HermesProfile = {
        id, name, label, description, descriptionSource: meta.description || bot?.description ? 'profile.yaml' : soul ? 'Extracto literal de SOUL.md' : 'Sin descripción',
        color: typeof bot?.color === 'string' && /^#[0-9a-f]{6}$/i.test(bot.color) ? bot.color : colors[parseInt(digest(name).slice(0, 4), 16) % colors.length],
        active: name === active, files, agentId: `identity-${digest(id)}`,
        mcp: mcpMetadata(id, config),
        botId: bot ? `desktop-bot-${digest(id)}` : null,
        botLabel: bot ? redact(bot?.title, 100) || label : null,
        section: redact(bot?.sectionName, 100) || null,
        channels: Object.entries(config.platforms || {}).filter(([platform, settings]) => /^[a-z0-9_-]{1,64}$/.test(platform) && settings && typeof settings === 'object')
          .slice(0, 30).map(([platform, settings]) => ({ name: platform, enabled: (settings as { enabled?: boolean }).enabled === true })),
      };
      result.profiles.push(profile);
      // Session cwd values are historical execution metadata, not current spaces.
      for (const [file, kind] of [['projects.db', 'projects']] as const) {
        try {
          const { rows, supported } = readHermesDatabase(root, join(home, file), kind);
          if (existsSync(join(home, file)) && !supported) result.warnings.push(`Esquema ${file} no reconocido en ${name}.`);
          for (const row of rows) {
            const path = typeof row.path === 'string' ? row.path.trim() : '';
            if (path === root || path === home || path === '/') continue;
            const key = path ? digest(root + ':' + path) : digest(id + ':' + String(row.id));
            const existing = spaces.get(key);
            if (existing) {
              if (!existing.profileIds.includes(id)) existing.profileIds.push(id);
              if (row.source === 'project' && existing.source !== 'project') {
                existing.source = 'project'; existing.label = redact(row.label, 100) || existing.label;
                existing.description = 'Proyecto declarado en Hermes. Su contenido no se ha leído.';
              }
              continue;
            }
            spaces.set(key, { id: `space-${key}`, label: redact(row.label, 100) || redact(basename(path), 100) || 'Proyecto sin carpeta', profileIds: [id],
              source: row.source as HermesSpace['source'], description: row.source === 'workspace' ? 'Carpeta registrada en sesiones de Hermes; actividad actual no comprobada.' : 'Recurso registrado por Hermes. Su contenido no se ha leído.' });
          }
        } catch { result.warnings.push(`No se pudo leer ${file} de ${name}; no se ha modificado.`); }
      }
    }
    result.spaces = [...spaces.values()].slice(0, 300);
    if (spaces.size > 300) result.warnings.push('Se muestran los primeros 300 espacios registrados.');
    result.warnings.push('Perfiles encontrados en el directorio de datos local. No se ha verificado el listado actual de Desktop. Los bots solo se identifican por metadatos explícitos en profile.yaml.');
    result.state = result.profiles.length ? result.warnings.length ? 'partial' : 'available' : 'missing';
    this.cached = result; this.cachedAt = Date.now();
    return result;
  }
}
