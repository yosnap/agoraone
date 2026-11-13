import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoreLink } from './core-proxy';

export const coreUrl = 'http://127.0.0.1:4318';

// What the core may inherit: where to find programs, the user's locale and temp folder, and what uv needs
// to download Python behind a proxy. Never the backend's .env, provider keys or tokens.
const inherited = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'UV_CACHE_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];

/** The core's whole environment: the start secret, the backend's PID to watch, and the inherited basics. */
export function coreEnvironment(secret: string, backendPid: number, env: NodeJS.ProcessEnv = process.env) {
  const result: NodeJS.ProcessEnv = { AGORA_CORE_SECRET: secret, AGORA_BACKEND_PID: String(backendPid), PYTHONUNBUFFERED: '1' };
  for (const name of inherited) if (env[name]) result[name] = env[name];
  return result;
}

const exitMessages: Record<number, string> = {
  2: 'falta el secreto de arranque',
  3: 'el puerto 4318 está ocupado; comprueba quién lo usa con «lsof -iTCP:4318 -sTCP:LISTEN»',
};

/** Starts the Python core next to the backend with a fresh secret, and stops it with the backend. */
export function startCore(directory = resolve('core')): { link: CoreLink; child: ChildProcess | null } {
  const link = { url: coreUrl, secret: randomBytes(32).toString('hex') };
  if (!existsSync(resolve(directory, 'pyproject.toml'))) {
    console.warn('AgoraOne: no se encuentra el núcleo (carpeta core); se sigue sin él.');
    return { link, child: null };
  }
  const child = spawn('uv', ['run', '--frozen', '--quiet', 'python', '-m', 'agora_core'], {
    cwd: directory, env: coreEnvironment(link.secret, process.pid), stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', () => console.warn('AgoraOne: no se pudo arrancar el núcleo; instala uv (https://docs.astral.sh/uv/) y reinicia.'));
  child.on('exit', code => { if (code) console.warn(`AgoraOne: el núcleo se detuvo (${exitMessages[code] ?? `código ${code}`}).`); });
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
  process.once('exit', stop);
  // Other modules may also handle these signals; exit here only when nobody else will.
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]] as const) {
    process.once(signal, () => { stop(); if (process.listenerCount(signal) === 0) process.exit(128 + number); });
  }
  return { link, child };
}
