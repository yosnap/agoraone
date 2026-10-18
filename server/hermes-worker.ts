import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Progress = { type: 'status'; stage: 'starting' | 'generating'; startupMs?: number } | { type: 'delta'; text: string }
  | { type: 'tool'; state: 'start' | 'end'; name: string }
  | { type: 'approval'; requestId: string; tool: string; description: string; args: string; redacted: boolean; truncated: boolean; length: number; rewritable: boolean }
  | { type: 'approval-settled'; requestId: string; reason: string };
type Pending = { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; progress?: (event: Progress) => void; timer: NodeJS.Timeout };
type Worker = { child: ChildProcessWithoutNullStreams; pending?: Pending; idle?: NodeJS.Timeout };
const workers = new Map<string, Worker>();
const failure = () => new Error('Hermes no completó la petición. No se ha guardado este turno; puedes reintentarlo.');

function discard(key: string, worker: Worker) {
  if (workers.get(key) === worker) workers.delete(key);
  clearTimeout(worker.idle);
  if (worker.pending) { clearTimeout(worker.pending.timer); worker.pending.reject(failure()); worker.pending = undefined; }
  // Closing stdin lets a bridge shut its MCP servers down; signals follow if it does not exit.
  const { child } = worker;
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  // The bridge leads its own process group, so MCP servers and other children go with it.
  const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch { child.kill(name); } };
  const term = setTimeout(() => signal('SIGTERM'), 3000), kill = setTimeout(() => signal('SIGKILL'), 8000);
  term.unref(); kill.unref();
  child.once('exit', () => { clearTimeout(term); clearTimeout(kill); });
}

export function closeHermesWorkers() { for (const [key, worker] of workers) { discard(key, worker); try { process.kill(-worker.child.pid!, 'SIGKILL'); } catch { worker.child.kill('SIGKILL'); } } }
process.once('exit', closeHermesWorkers);
// Bridges run in their own process groups, so a terminal Ctrl+C no longer reaches them: close them here.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { closeHermesWorkers(); process.exit(130); });

/** Sends a line to a conversation's running worker (an approval answer); false if none is running. */
export function workerSend(key: string, payload: Record<string, unknown>) {
  const worker = workers.get(key);
  if (!worker?.pending) return false;
  worker.child.stdin.write(`${JSON.stringify(payload)}\n`);
  return true;
}

export function workerRequest(key: string, python: string, script: string, home: string, env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>, progress?: (event: Progress) => void, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  let worker = workers.get(key);
  if (!worker) {
    // Bounded process count per kind (profile agents and Luma apart); evict only idle conversations.
    const kind = (name: string) => name.startsWith('agent:');
    const same = [...workers].filter(([name]) => kind(name) === kind(key));
    if (same.length >= 4) {
      const idle = same.find(([, item]) => !item.pending);
      if (idle) discard(...idle);
      else return Promise.reject(new Error('Hermes está ocupado. Espera antes de continuar.'));
    }
    const child = spawn(python, [script], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
      if (bytes > 8_000_000) discard(key, created);
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
        else if (event.type === 'tool' && ['start', 'end'].includes(event.state) && typeof event.name === 'string')
          pending.progress?.({ type: 'tool', state: event.state, name: event.name.slice(0, 120) });
        else if (event.type === 'approval' && typeof event.requestId === 'string' && /^[a-f0-9]{32}$/.test(event.requestId))
          pending.progress?.({ type: 'approval', requestId: event.requestId, tool: String(event.tool).slice(0, 120),
            description: String(event.description ?? '').slice(0, 500), args: String(event.args ?? '').slice(0, 12_000),
            redacted: event.redacted === true, truncated: event.truncated === true, length: Number(event.length) || 0, rewritable: event.rewritable === true });
        else if (event.type === 'approval-settled' && typeof event.requestId === 'string' && /^[a-f0-9]{32}$/.test(event.requestId))
          pending.progress?.({ type: 'approval-settled', requestId: event.requestId, reason: String(event.reason ?? '').slice(0, 40) });
      } catch { discard(key, created); }
    });
  }
  const selected = worker;
  if (selected.pending) return Promise.reject(new Error('Esta conversación ya tiene una respuesta en curso.'));
  clearTimeout(selected.idle);
  return new Promise((resolve, reject) => {
    selected.pending = { resolve, reject, progress, timer: setTimeout(() => discard(key, selected), timeoutMs) };
    selected.child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}
