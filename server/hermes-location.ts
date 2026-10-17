import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

export function hermesLocation(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const expand = (value: string) => resolve(value.startsWith('~/') ? join(home, value.slice(2)) : value);
  let root = expand(env.AGORA_HERMES_HOME || env.HERMES_HOME || join(home, '.hermes'));
  if (!env.AGORA_HERMES_HOME && basename(dirname(root)) === 'profiles') root = dirname(dirname(root));
  const candidates = [env.AGORA_HERMES_PATH ? expand(env.AGORA_HERMES_PATH) : '', join(root, 'hermes-agent'), join(home, '.hermes/hermes-agent')].filter(Boolean);
  const installation = candidates.find(path => existsSync(join(path, 'run_agent.py'))) || candidates[0];
  return { root, installation, python: env.AGORA_HERMES_PYTHON || join(installation, 'venv/bin/python'),
    source: env.AGORA_HERMES_HOME ? 'AGORA_HERMES_HOME' : env.HERMES_HOME ? 'HERMES_HOME' : 'Directorio Hermes del usuario' };
}
