import { Worker } from 'node:worker_threads';
import type { HermesActivity } from '../shared/hermes-activity';
import type { LibraryDocument } from './library';
import { VaultError, type VaultNotes } from './vault-notes';

type Pending = { worker: Worker; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
// The limit applies to running a task, not to waiting in the queue; the queue is bounded instead.
const runLimitMs = 20_000, maxQueued = 8;
const unavailable = () => new Error('Lectura local no disponible. Inténtalo de nuevo.');

/** Main-thread side of read-worker.ts: one long-lived worker, replaced if it crashes or a task hangs. */
export class BackgroundReads {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private next = 0;
  constructor(private obsidianRegistry?: string | null) {}

  /** Rejects only the requests sent to this worker, so its replacement keeps its own. */
  private retire(worker: Worker) {
    if (this.worker === worker) this.worker = undefined;
    for (const [id, job] of this.pending) {
      if (job.worker !== worker) continue;
      clearTimeout(job.timer); this.pending.delete(id); job.reject(unavailable());
    }
  }

  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./read-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { obsidianRegistry: this.obsidianRegistry } });
    worker.unref();
    worker.on('message', ({ id, started, ok, value, vault }: { id: number; started?: boolean; ok?: boolean; value?: unknown; vault?: boolean }) => {
      const job = this.pending.get(id);
      if (!job) return;
      if (started) {
        // A task that runs too long is treated as stuck: replace the worker and fail what it held.
        job.timer = setTimeout(() => { this.retire(worker); void worker.terminate(); }, runLimitMs);
        return;
      }
      this.pending.delete(id); clearTimeout(job.timer);
      if (ok) job.resolve(value); else job.reject(vault ? new VaultError() : unavailable());
    });
    worker.on('error', () => this.retire(worker));
    worker.on('exit', () => this.retire(worker));
    this.worker = worker;
    return worker;
  }

  private ask<T>(job: Record<string, unknown>): Promise<T> {
    const worker = this.start();
    if ([...this.pending.values()].filter(item => item.worker === worker).length >= maxQueued) return Promise.reject(unavailable());
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { worker, resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, job });
    });
  }

  activity(root: string, profiles: { id: string; name: string; home: string; mcp?: string[] }[]) { return this.ask<HermesActivity>({ task: 'activity', root, profiles }); }
  vaultList(vaultId: string) { return this.ask<ReturnType<VaultNotes['list']>>({ task: 'vault-list', vaultId }); }
  vaultRead(vaultId: string, noteId: string, reveal = false) { return this.ask<ReturnType<VaultNotes['read']>>({ task: 'vault-read', vaultId, noteId, reveal }); }
  vaultSearch(vaultId: string, query: string) { return this.ask<ReturnType<VaultNotes['search']>>({ task: 'vault-search', vaultId, query }); }
  vaultDocument(noteId: string) { return this.ask<LibraryDocument>({ task: 'vault-document', noteId }); }
  close() { const worker = this.worker; if (worker) { this.retire(worker); return worker.terminate(); } }
}
