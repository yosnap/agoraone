import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HermesDiscovery } from './hermes-catalog';
import { hermesLocation } from './hermes-location';
import { maskSecrets } from './secret-lines';

// Calling one MCP tool of a profile by hand (user's decision, 18/10/2026), in server/hermes_mcp_call.py:
// the client names the profile, an opaque server id and a tool from Hermes' saved catalogue for that
// server, with the arguments the user wrote and confirmed. Only one call runs per server at a time.
const script = fileURLToPath(new URL('./hermes_mcp_call.py', import.meta.url));
const running = new Set<string>();

export class McpCallError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function callMcpTool(discovery: HermesDiscovery, profileId: string, serverId: string, tool: string, args: Record<string, unknown>) {
  let target: ReturnType<HermesDiscovery['mcpServer']>;
  try { target = discovery.mcpServer(profileId, serverId); } catch { throw new McpCallError('Servidor MCP no disponible para este perfil.', 404); }
  if (target.config.enabled === false) throw new McpCallError('Este servidor está deshabilitado en Hermes para este perfil.', 409);
  const catalogue = discovery.mcpTools(profileId, serverId);
  const entry = ['cached', 'expired'].includes(catalogue.state) ? catalogue.tools.find(item => item.name === tool) : undefined;
  if (!entry) throw new McpCallError('Esa herramienta no está en el catálogo guardado de este servidor.', 404);
  // Only the parameters the tool declares, and all of its required ones.
  const unknown = Object.keys(args).filter(key => !entry.parameters.some(parameter => parameter.name === key));
  if (unknown.length) throw new McpCallError(`La herramienta no tiene ${unknown.length === 1 ? 'el parámetro' : 'los parámetros'} ${unknown.map(key => `«${key}»`).join(', ')}.`);
  const missing = entry.parameters.filter(parameter => parameter.required && !Object.hasOwn(args, parameter.name));
  if (missing.length) throw new McpCallError(`Falta ${missing.map(parameter => `«${parameter.name}»`).join(', ')}, que es obligatorio.`);
  const key = `${profileId}:${serverId}`;
  if (running.has(key)) throw new McpCallError('Ya hay una llamada en curso a este servidor. Espera a que termine.', 409);
  const { installation, python } = hermesLocation();
  if (!existsSync(python)) throw new McpCallError('No se encuentra la instalación de Hermes.', 500);
  running.add(key);
  try {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      // Own process group: the MCP server it starts goes with it if it has to be stopped.
      const child = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'ignore'], detached: true,
        // The user's PATH (no secrets) so launchers like npx or uvx are found, as in the profile's gateway.
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: homedir(), HERMES_HOME: target.root, AGORA_HERMES_PATH: installation, PYTHONDONTWRITEBYTECODE: '1',
          // Locale, temporary folder and user name (no secrets): some servers need them to start.
          ...Object.fromEntries(['LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : [])) } });
      let output = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 120_000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('error', () => { clearTimeout(timer); reject(new McpCallError('No se pudo ejecutar Hermes.', 500)); });
      child.on('close', () => {
        clearTimeout(timer);
        if (timedOut) return reject(new McpCallError('La herramienta tardó más de 2 minutos y se detuvo: no se sabe si llegó a completar su acción en el servicio.', 504));
        try { resolve(JSON.parse(output)); } catch { reject(new McpCallError('Hermes no pudo completar la llamada.', 500)); }
      });
      child.stdin.end(JSON.stringify({ profile: target.profile, server: target.server, tool, args }));
    });
    // The service's own error text is shown masked, like its results.
    if (data.ok !== true) throw new McpCallError(typeof data.error === 'string' ? maskSecrets(data.error).text : 'La llamada falló.', 502);
    // The answer is shown to the user only; lines that look like credentials stay hidden, as everywhere else.
    const masked = maskSecrets(String(data.result ?? ''));
    return { result: masked.text, hidden: masked.hidden.length, truncated: data.truncated === true };
  } finally { running.delete(key); }
}
