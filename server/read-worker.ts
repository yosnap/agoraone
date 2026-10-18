import { parentPort, workerData } from 'node:worker_threads';
import { readActivity } from './hermes-activity';
import { VaultError, VaultNotes, VaultWriteError } from './vault-notes';

// Runs the synchronous SQLite and file-system reads (Hermes activity, Obsidian notes) off the
// server's main thread. The worker lives as long as the server, so its caches persist.
const vault = new VaultNotes(workerData?.obsidianRegistry);
type Task =
  | { task: 'activity'; root: string; profiles: Parameters<typeof readActivity>[1] }
  | { task: 'vault-list'; vaultId: string }
  | { task: 'vault-read'; vaultId: string; noteId: string; reveal?: boolean }
  | { task: 'vault-search'; vaultId: string; query: string }
  | { task: 'vault-document'; noteId: string }
  | { task: 'vault-save'; vaultId: string; noteId: string; content: string; revision: string; revealed?: boolean; backups: string }
  | { task: 'vault-create'; vaultId: string; folder: string; title: string; content: string };

function run(job: Task) {
  if (job.task === 'activity') return readActivity(job.root, job.profiles);
  if (job.task === 'vault-list') return vault.list(job.vaultId);
  if (job.task === 'vault-read') return vault.read(job.vaultId, job.noteId, job.reveal);
  if (job.task === 'vault-search') return vault.search(job.vaultId, job.query);
  // Writes run here too, so this worker's cached listing is refreshed at once.
  if (job.task === 'vault-save') return vault.save(job.vaultId, job.noteId, job, job.backups);
  if (job.task === 'vault-create') return vault.create(job.vaultId, job.folder, job.title, job.content);
  return vault.document(job.noteId);
}

parentPort!.on('message', ({ id, job }: { id: number; job: Task }) => {
  parentPort!.postMessage({ id, started: true }); // the run time limit starts now, not while queued
  try { parentPort!.postMessage({ id, ok: true, value: run(job) }); }
  catch (error) {
    const write = error instanceof VaultWriteError ? { status: error.status, message: error.message } : undefined;
    parentPort!.postMessage({ id, ok: false, vault: error instanceof VaultError, write });
  }
});
