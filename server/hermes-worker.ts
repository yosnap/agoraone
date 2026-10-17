import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Progress = { type: 'status'; stage: 'starting' | 'generating'; startupMs?: number } | { type: 'delta'; text: string };
type Pending = { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; progress?: (event: Progress) => void; timer: NodeJS.Timeout };
type Worker = { child: ChildProcessWithoutNullStreams; pending?: Pending; idle?: NodeJS.Timeout };
const workers = new Map<string, Worker>();
const failure = () => new Error('Hermes no completó la petición. No se ha guardado este turno; puedes reintentarlo.');

function discard(key: string, worker: Worker) {
  if (workers.get(key) === worker) workers.delete(key);
  clearTimeout(worker.idle);
  if (worker.pending) { clearTimeout(worker.pending.timer); worker.pending.reject(failure()); worker.pending = undefined; }
  worker.child.kill('SIGKILL');
}

export function closeHermesWorkers() { for (const [key, worker] of workers) discard(key, worker); }
process.once('exit', closeHermesWorkers);

export function workerRequest(key: string, python: string, script: string, home: string, env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>, progress?: (event: Progress) => void): Promise<Record<string, unknown>> {
  let worker = workers.get(key);
  if (!worker) {
    // Bounded process count; evict only idle conversations. No shared workers.
    if (workers.size >= 4) {
      const idle = [...workers].find(([, item]) => !item.pending);
      if (idle) discard(...idle);
      else return Promise.reject(new Error('Hermes está ocupado. Espera antes de continuar.'));
    }
    const child = spawn(python, [script], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const created: Worker = { child };
    worker = created;
    workers.set(key, created);
    child.stderr.resume(); // Never forward provider logs or raw exceptions.
    child.stdin.on('error', () => discard(key, created));
    child.on('error', () => discard(key, created));
    child.on('close', () => discard(key, created));
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2_000_000) discard(key, created);
    });
    createInterface({ input: child.stdout }).on('line', line => {
      const pending = created.pending;
      if (!pending) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'done') {
          if (!event.ok) { discard(key, created); return; }
          clearTimeout(pending.timer); created.pending = undefined; bytes = 0;
          created.idle = setTimeout(() => discard(key, created), 5 * 60_000);
          created.idle.unref();
          pending.resolve(event);
          if (payload.action === 'check') discard(key, created);
        } else if (event.type === 'delta' && typeof event.text === 'string') pending.progress?.({ type: 'delta', text: event.text });
        else if (event.type === 'status' && ['starting', 'generating'].includes(event.stage))
          pending.progress?.({ type: 'status', stage: event.stage, startupMs: event.startupMs });
      } catch { discard(key, created); }
    });
  }
  const selected = worker;
  if (selected.pending) return Promise.reject(new Error('Esta conversación ya tiene una respuesta en curso.'));
  clearTimeout(selected.idle);
  return new Promise((resolve, reject) => {
    selected.pending = { resolve, reject, progress, timer: setTimeout(() => discard(key, selected), 120_000) };
    selected.child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}
