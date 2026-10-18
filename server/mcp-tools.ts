import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readHermesFile, redact } from './hermes-safe-read';
import type { McpTools } from '../shared/hermes-catalog';

// Hermes mcp_schema_cache.config_fingerprint: Python sorted JSON, ASCII escaped.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${canonical(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function mcpFingerprint(config: Record<string, any>): string {
  const filters = config.tools || {};
  const raw = canonical({ command: config.command ?? null, args: config.args || [], url: config.url ?? null,
    transport: config.transport ?? null, tools_include: [...(filters.include || [])].sort(), tools_exclude: [...(filters.exclude || [])].sort() });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
export const toolName = /^[A-Za-z0-9_.:/-]{1,200}$/, parameterName = /^[A-Za-z0-9_.$-]{1,100}$/;
export function readMcpTools(root: string, home: string, name: string, config: Record<string, any>): McpTools {
  const result: McpTools = { source: 'hermes-cache', state: 'missing', recordedAt: null, truncated: false, tools: [] };
  try {
    const cache = JSON.parse(readHermesFile(root, join(home, 'cache/mcp_schema_cache.json'), 4 * 1024 * 1024).toString());
    const entry = Object.hasOwn(cache, name) ? cache[name] : undefined;
    if (!entry || typeof entry !== 'object') return result;
    if (entry.fingerprint !== mcpFingerprint(config)) return { ...result, state: 'changed' };
    if (!Array.isArray(entry.tools)) return { ...result, state: 'unavailable' };
    const written = typeof entry.written_at === 'number' ? entry.written_at * 1000 : NaN;
    result.recordedAt = Number.isFinite(written) && Math.abs(written) < 8.64e15 ? new Date(written).toISOString() : null;
    result.state = typeof entry.ttl_ms === 'number' && Number.isFinite(written) && Date.now() - written >= entry.ttl_ms ? 'expired' : 'cached';
    result.truncated = entry.tools.length > 500;
    // Names and parameter keys are sent back to the server exactly: they must match a strict pattern instead
    // of being masked (a masked name could never be called). Descriptions are free text and stay masked.
    result.tools = entry.tools.slice(0, 500).flatMap((tool: any) => {
      if (!tool || typeof tool.name !== 'string' || !toolName.test(tool.name)) return [];
      const properties = tool.inputSchema?.properties;
      const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
      const parameters = properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.entries(properties).filter(([key]) => parameterName.test(key)).slice(0, 100).map(([key, spec]) => ({ name: key, required: required.includes(key),
          type: typeof (spec as any)?.type === 'string' ? redact((spec as any).type, 40) : 'no especificado',
          ...(typeof (spec as any)?.description === 'string' ? { description: redact((spec as any).description, 300) } : {}),
          ...(Array.isArray((spec as any)?.enum) ? { options: (spec as any).enum.filter((item: unknown) => typeof item === 'string' && item.length <= 200 && !/[\u0000-\u001f]/.test(item)).slice(0, 100) } : {}) })) : [];
      return [{ name: tool.name, description: redact(tool.description, 1600), parameters }];
    });
    return result;
  } catch (error) { return { ...result, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }; }
}
