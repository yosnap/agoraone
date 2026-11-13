import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoreLink } from './core-proxy';

export const coreUrl = 'http://127.0.0.1:4318';

/**
 * Starts the Python core next to the backend with a fresh secret, and stops it with the backend.
 * The core gets a minimal environment: never the backend's .env, provider keys or tokens.
 */
export function startCore(directory = resolve('core')): { link: CoreLink; child: ChildProcess | null } {
  const link = { url: coreUrl, secret: randomBytes(32).toString('hex') };
  if (!existsSync(resolve(directory, 'pyproject.toml'))) {
    console.warn('AgoraOne: no se encuentra el núcleo (carpeta core); se sigue sin él.');
    return { link, child: null };
  }
  const env: NodeJS.ProcessEnv = { AGORA_CORE_SECRET: link.secret, PYTHONUNBUFFERED: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'UV_CACHE_DIR']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn('uv', ['run', '--frozen', '--quiet', 'python', '-m', 'agora_core'], { cwd: directory, env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', () => console.warn('AgoraOne: no se pudo arrancar el núcleo; instala uv (https://docs.astral.sh/uv/) y reinicia.'));
  child.on('exit', code => { if (code) console.warn(`AgoraOne: el núcleo se detuvo (código ${code}).`); });
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { stop(); process.exit(0); });
  return { link, child };
}
