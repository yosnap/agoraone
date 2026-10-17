import { workerRequest, type Progress } from './hermes-worker';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentSource, LibraryDocument } from './library';
import { hermesLocation } from './hermes-location';
import type { ProfileContext } from './profile-context';

export type Message = { role: 'user' | 'assistant'; content: string; sources?: DocumentSource[]; identity?: { profileId: string; files: { name: string; revision: string }[] } };
export type Turn = { sessionId: string; message: string; history: Message[]; document?: LibraryDocument; profile?: ProfileContext };
export type Adapter = (turn: Turn, progress?: (event: Progress) => void) => Promise<string>;
const { installation, python } = hermesLocation();

export function readiness() {
  const installed = existsSync(`${installation}/run_agent.py`) && existsSync(python);
  const configured = ['AGORA_MODEL', 'AGORA_BASE_URL', 'AGORA_API_KEY'].every(k => !!process.env[k]);
  return { installed, configured, mode: 'hermes-python', tools: [],
    state: !installed ? 'missing' : !configured ? 'needs-configuration' : 'configured',
    detail: !installed ? 'No se encuentra la instalación de Hermes.' : !configured
      ? 'Falta configurar proveedor, modelo y autenticación en el backend.'
      : 'Configurado. La conexión se verifica al enviar un mensaje.' };
}

export async function runBridge(payload: Record<string, unknown>, progress?: (event: Progress) => void): Promise<Record<string, unknown>> {
  if (payload.action !== 'check' && (typeof payload.sessionId !== 'string' || !/^agora-[a-f0-9-]{36}$/.test(payload.sessionId))) throw new Error('Sesión no válida.');
  const home = payload.sessionId ? resolve('.agora/hermes-conversations', String(payload.sessionId)) : resolve('.agora/hermes');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Do not inherit provider credentials, profile selection, MCP or CLI routing from the shell.
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, HERMES_HOME: home,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    AGORA_HERMES_PATH: installation,
    AGORA_MODEL: process.env.AGORA_MODEL,
    AGORA_BASE_URL: process.env.AGORA_BASE_URL,
    AGORA_API_KEY: process.env.AGORA_API_KEY,
  };
  return workerRequest(String(payload.sessionId || 'check'), python, resolve('server/hermes_bridge.py'), home, env, payload, progress);
}

export const hermesReply: Adapter = async (turn, progress) => {
  if (readiness().state !== 'configured') throw new Error(readiness().detail);
  const data = await runBridge({ ...turn, history: turn.history.map(({ role, content }) => ({ role, content })), action: 'chat' }, progress);
  if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Hermes devolvió una respuesta vacía.');
  return data.reply;
};
