export type HermesFile = { name: 'SOUL.md' | 'MEMORY.md' | 'USER.md'; state: 'available' | 'missing' | 'unavailable'; bytes?: number; revision?: string; content?: string; hidden?: number; hiddenChars?: number };
export type McpTools = {
  source: 'hermes-cache'; state: 'cached' | 'expired' | 'changed' | 'missing' | 'unavailable';
  recordedAt: string | null; truncated: boolean;
  tools: { name: string; description: string; parameters: { name: string; type: string; required: boolean; description?: string; options?: string[] }[] }[];
};
export type HermesProfile = {
  id: string; name: string; label: string; description: string; descriptionSource: string;
  color: string; active: boolean; files: HermesFile[];
  agentId: string; botId: string | null; botLabel: string | null; section: string | null;
  channels: { name: string; enabled: boolean }[];
  mcp?: { id: string; name: string; enabled: boolean; transport: 'http' | 'stdio' | 'unknown'; connection: 'unverified' }[];
};
export type HermesSpace = {
  id: string; label: string; profileIds: string[];
  source: 'project' | 'workspace' | 'repository'; description: string;
};
export type HermesCatalog = {
  schema: 1; state: 'available' | 'partial' | 'missing'; scannedAt: string;
  installation: { detected: boolean; version: string | null; source: string; compatibility: string };
  profiles: HermesProfile[]; spaces: HermesSpace[]; warnings: string[];
  vaults?: { id: string; name: string; available: boolean; source: 'obsidian-registry' }[];
};
