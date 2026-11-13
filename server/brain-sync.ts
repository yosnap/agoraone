import type { BackgroundReads } from './background-reads';
import { coreRequest } from './core-client';
import type { CoreLink } from './core-proxy';
import { obsidianVaults } from './resource-discovery';

const intervalMs = 5 * 60_000;
const firstRunMs = 5_000;
const maxBatchBytes = 512 * 1024, maxBatchNotes = 100;

type Listed = Awaited<ReturnType<BackgroundReads['vaultList']>>;
type Outgoing = { ref: string; title: string; folder: string; revision: string; modifiedAt: string; text: string };
export type SyncReport = { vaults: number; sent: number; removed: number; skipped: number };

/** What decides whether a note changed: cheap to compute without reading it. */
const revision = (note: Listed['notes'][number]) => `${note.modifiedAt}|${note.bytes}`;

/**
 * Keeps the core's index in step with the Obsidian vaults. Notes are read here, with the vault reader's
 * rules (Markdown only, no symlinks or hidden folders, size limit) and with credential-like lines masked,
 * so the core only ever receives clean text and never reads the disk itself.
 */
export class BrainSync {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private reads: BackgroundReads, private core: CoreLink, private registry?: string | null) {}

  /** First run a few seconds after start (the core needs a moment), then every five minutes. */
  start() {
    const run = async () => {
      try { await this.sync(); }
      catch (error) { console.warn(`AgoraOne: índice del cerebro sin actualizar (${(error as Error).message}).`); }
      finally { this.timer = setTimeout(run, intervalMs); this.timer.unref(); }
    };
    this.timer = setTimeout(run, firstRunMs);
    this.timer.unref();
  }

  stop() { clearTimeout(this.timer); }

  async sync(): Promise<SyncReport> {
    if (this.running) return { vaults: 0, sent: 0, removed: 0, skipped: 0 };
    this.running = true;
    const report: SyncReport = { vaults: 0, sent: 0, removed: 0, skipped: 0 };
    try {
      for (const vault of obsidianVaults(this.registry).vaults.filter(item => item.available)) {
        const listed = await this.reads.vaultList(vault.id, true);
        const { refs } = await coreRequest<{ refs: Record<string, string> }>(this.core, `/internal/index/state?source=${vault.id}`);
        const readable = listed.notes.filter(note => note.readable);
        const changed = readable.filter(note => refs[note.id] !== revision(note));
        report.skipped += listed.notes.length - readable.length;
        let batch: Outgoing[] = [], size = 0;
        const flush = async () => {
          if (!batch.length) return;
          await coreRequest(this.core, '/internal/index/notes', { source: vault.id, sourceName: listed.vault.name, notes: batch });
          report.sent += batch.length;
          batch = []; size = 0;
        };
        for (const note of changed) {
          let text: string;
          try { text = (await this.reads.vaultRead(vault.id, note.id)).content; } catch { report.skipped++; continue; }
          batch.push({ ref: note.id, title: note.title, folder: note.folder, revision: revision(note), modifiedAt: note.modifiedAt, text });
          size += text.length;
          if (size >= maxBatchBytes || batch.length >= maxBatchNotes) await flush();
        }
        await flush();
        // A truncated walk does not list every note: removing the unlisted ones would empty the index.
        if (!listed.truncated) {
          const present = new Set(readable.map(note => note.id));
          const gone = Object.keys(refs).filter(ref => !present.has(ref));
          if (gone.length) report.removed += (await coreRequest<{ removed: number }>(this.core, '/internal/index/remove', { source: vault.id, refs: gone })).removed;
        }
        report.vaults++;
      }
      return report;
    } finally { this.running = false; }
  }
}
