// Browser checks run against the local Hermes installation, whose profile and MCP names are personal.
// Names come from environment variables or the untracked .agora/verify-targets.json, never from the repository.
import { existsSync, readFileSync } from 'node:fs';

const file = '.agora/verify-targets.json';
const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const keys = {
  profile: 'AGORA_TEST_PROFILE', // a profile with declared MCP servers
  mcp: 'AGORA_TEST_MCP', // an MCP name with a cached tool catalog in some profile
  uncachedProfile: 'AGORA_TEST_UNCACHED_PROFILE', // a profile without a cached catalog for that MCP
  secondaryMcp: 'AGORA_TEST_SECONDARY_MCP', // another MCP with a cached catalog
};

export function target(name) {
  const value = process.env[keys[name]] || local[name];
  if (!value) throw new Error(`Falta ${keys[name]} (o "${name}" en ${file}) para esta verificación.`);
  return value;
}
export const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** AgoraOne's address with the private access link (the token in .agora/access-token, never printed). */
export function appUrl(port = 5173) {
  const token = readFileSync('.agora/access-token', 'utf8').trim();
  return `http://127.0.0.1:${port}/#acceso=${token}`;
}
