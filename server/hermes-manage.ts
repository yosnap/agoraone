import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HermesDiscovery } from './hermes-catalog';
import { hermesLocation } from './hermes-location';
import { maskSecrets, restoreSecrets } from './secret-lines';

// Managing a profile's scheduled tasks and kanban cards (user's decision, 18/10/2026) with Hermes' own
// functions, in server/hermes_manage.py. The client names a profile id from the catalog and a task or card
// id; the profile directory is resolved here, and the script only touches what belongs to that profile.
const script = fileURLToPath(new URL('./hermes_manage.py', import.meta.url));

export class ManageError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function run(root: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { installation, python } = hermesLocation();
  if (!existsSync(python)) return Promise.reject(new ManageError('No se encuentra la instalación de Hermes.', 500));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', HOME: homedir(), HERMES_HOME: root, AGORA_HERMES_PATH: installation, PYTHONDONTWRITEBYTECODE: '1' } });
    let output = '';
    // Longer than Hermes' own 30 s wait for the jobs lock, so its answer arrives first.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new ManageError('No se pudo ejecutar Hermes.', 500)); });
    child.on('close', () => {
      clearTimeout(timer);
      let data: Record<string, unknown>;
      if (timedOut) return reject(new ManageError('Hermes tardó demasiado: no se sabe si el cambio se aplicó. Espera unos segundos y comprueba la lista.', 504));
      try { data = JSON.parse(output); } catch { return reject(new ManageError('Hermes no pudo completar la operación.', 500)); }
      if (data.ok !== true) return reject(new ManageError(typeof data.error === 'string' ? maskSecrets(data.error).text : 'Hermes rechazó la operación.', /no existe|no está asignada/.test(String(data.error)) ? 404 : 400));
      resolve(data);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function profileName(discovery: HermesDiscovery, id: string) {
  const profile = discovery.scan(true).profiles.find(item => item.id === id);
  if (!profile) throw new ManageError('Perfil no disponible.', 404);
  return { profile: profile.name, root: discovery.activityTargets().root };
}

/** A task's instructions for the editor: lines that look like credentials stay hidden unless edited back in. */
export async function jobDetail(discovery: HermesDiscovery, id: string, jobId: string) {
  const { profile, root } = profileName(discovery, id);
  const data = await run(root, { profile, kind: 'job', action: 'detail', jobId });
  const job = data.job as { id: string; name: string; schedule: string; once: boolean; prompt: string; revision: string };
  const masked = maskSecrets(job.prompt);
  return { ...job, prompt: masked.text, hidden: masked.hidden.length };
}

export async function manageJob(discovery: HermesDiscovery, id: string, jobId: string | null, change: Record<string, unknown>) {
  const { profile, root } = profileName(discovery, id);
  let prompt = change.prompt;
  // An edited prompt was shown masked: hidden lines come back from the task as stored in Hermes, which must
  // still be the version the user opened (the script checks the revision again right before saving).
  if (jobId && change.action === 'update' && typeof prompt === 'string') {
    const current = (await run(root, { profile, kind: 'job', action: 'detail', jobId })).job as { prompt: string; revision: string };
    if (current.revision !== change.revision) throw new ManageError('Las instrucciones de la tarea cambiaron mientras las editabas. Vuelve a abrirla para ver la versión actual.', 409);
    try { prompt = restoreSecrets(prompt, maskSecrets(current.prompt).hidden); }
    catch (error) { throw new ManageError(error instanceof Error ? error.message : 'Instrucciones no válidas.'); }
  }
  return run(root, { ...change, prompt, profile, kind: 'job', ...(jobId ? { jobId } : { action: 'create' }) });
}

export async function manageCard(discovery: HermesDiscovery, id: string, cardId: string | null, change: Record<string, unknown>) {
  const { profile, root } = profileName(discovery, id);
  return run(root, { ...change, profile, kind: 'card', ...(cardId ? { cardId } : { action: 'create' }) });
}
