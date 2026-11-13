import type { BackgroundReads } from './background-reads';
import { coreRequest } from './core-client';
import type { CoreLink } from './core-proxy';
import { obsidianVaults } from './resource-discovery';
import { maskSecrets } from './secret-lines';

const intervalMs = 5 * 60_000, retryMs = 30_000;
const firstRunMs = 5_000;
const maxBatchBytes = 512 * 1024, maxBatchNotes = 100;

type Listed = Awaited<ReturnType<BackgroundReads['vaultList']>>;
type Outgoing = { ref: string; title: string; folder: string; revision: string; modifiedAt: string; text: string };
export type SyncReport = { vaults: number; sent: number; removed: number; skipped: number; failed: number };

/** What decides whether a note changed: cheap to compute without reading it. */
const revision = (note: Listed['notes'][number]) => `${note.modifiedAt}|${note.bytes}`;
/** A title or folder name that looks like a credential is hidden like a note line. */
const masked = (name: string) => maskSecrets(name).hidden.length ? '[nombre oculto]' : name;

/**
 * Keeps the core's index in step with the Obsidian vaults. Notes are read here, with the vault reader's
 * rules (Markdown only, no symlinks or hidden folders, size limit) and with credential-like lines masked,
 * so the core only ever receives clean text and never reads the disk itself.
 */
export class BrainSync {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private reads: BackgroundReads, private core: CoreLink, private registry?: string | null) {}

  /** First run a few seconds after start, then every five minutes; sooner again if the core was not ready. */
  start() {
    const run = async () => {
      let wait = intervalMs;
      try {
        const report = await this.sync();
        if (report.failed) wait = retryMs;
      } catch (error) {
        console.warn(`AgoraOne: índice del cerebro sin actualizar (${(error as Error).message}).`);
        wait = retryMs;
      } finally { this.timer = setTimeout(run, wait); this.timer.unref(); }
    };
    this.timer = setTimeout(run, firstRunMs);
    this.timer.unref();
  }

  stop() { clearTimeout(this.timer); }

  async sync(): Promise<SyncReport> {
    const report: SyncReport = { vaults: 0, sent: 0, removed: 0, skipped: 0, failed: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const registry = obsidianVaults(this.registry);
      // Vaults that left Obsidian's registry leave the index; not when the registry could not be read.
      if (!registry.warnings.length) {
        report.removed += (await coreRequest<{ removed: number }>(this.core, '/internal/index/sources', { keep: registry.vaults.map(vault => vault.id) })).removed;
      }
      // One vault failing (unreadable, rejected batch) must not leave the others unindexed.
      for (const vault of registry.vaults.filter(item => item.available)) {
        try { await this.syncVault(vault.id, report); report.vaults++; }
        catch (error) {
          report.failed++;
          console.warn(`AgoraOne: no se pudo indexar un vault (${(error as Error).message}).`);
        }
      }
      return report;
    } finally { this.running = false; }
  }

  private async syncVault(vaultId: string, report: SyncReport) {
    const listed = await this.reads.vaultList(vaultId, true);
    const { refs } = await coreRequest<{ refs: Record<string, string> }>(this.core, `/internal/index/state?source=${vaultId}`);
    const readable = listed.notes.filter(note => note.readable);
    const changed = readable.filter(note => refs[note.id] !== revision(note));
    report.skipped += listed.notes.length - readable.length;
    let batch: Outgoing[] = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await coreRequest(this.core, '/internal/index/notes', { source: vaultId, sourceName: listed.vault.name, notes: batch });
      report.sent += batch.length;
      batch = []; size = 0;
    };
    for (const note of changed) {
      let text: string;
      try { text = (await this.reads.vaultRead(vaultId, note.id)).content; } catch { report.skipped++; continue; }
      batch.push({ ref: note.id, title: masked(note.title), folder: masked(note.folder), revision: revision(note), modifiedAt: note.modifiedAt, text });
      size += text.length;
      if (size >= maxBatchBytes || batch.length >= maxBatchNotes) await flush();
    }
    await flush();
    // A truncated walk does not list every note: removing the unlisted ones would empty the index.
    if (!listed.truncated) {
      const present = new Set(readable.map(note => note.id));
      const gone = Object.keys(refs).filter(ref => !present.has(ref));
      if (gone.length) report.removed += (await coreRequest<{ removed: number }>(this.core, '/internal/index/remove', { source: vaultId, refs: gone })).removed;
    }
  }
}
