import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { within } from './hermes-safe-read';

// No Hermes imports: its DB constructors run migrations even for listing APIs.
/** Opens a Hermes SQLite file read-only (no links, no extensions) for one callback; null if absent. */
export function withHermesDatabase<T>(root: string, file: string, read: (db: DatabaseSync, columns: (table: string) => Set<unknown>) => T): T | null {
  if (!existsSync(file)) return null;
  if (!within(root, file) || realpathSync(file) !== file || !statSync(file).isFile() || statSync(file).nlink !== 1) throw new Error('Unavailable');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=200');
    return read(db, table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)));
  } finally { db.close(); }
}

export function readHermesDatabase(root: string, file: string, kind: 'projects' | 'sessions') {
  return withHermesDatabase(root, file, (db, columns) => {
    if (kind === 'projects') {
      const p = columns('projects'), r = columns('discovered_repos');
      const rows: Record<string, unknown>[] = [];
      if (['id', 'name', 'primary_path', 'archived'].every(key => p.has(key)))
        rows.push(...db.prepare("SELECT id, name AS label, primary_path AS path, 'project' AS source FROM projects WHERE archived=0 LIMIT 200").all());
      if (r.has('root') && r.has('label'))
        rows.push(...db.prepare("SELECT root AS path, label, 'repository' AS source FROM discovered_repos LIMIT 200").all());
      return { rows, supported: p.size > 0 || r.size > 0 };
    }
    const s = columns('sessions');
    if (!s.has('cwd')) return { rows: [], supported: false };
    // Metadata only. No messages, model config, prompts or chat identifiers are read.
    return { rows: db.prepare("SELECT DISTINCT cwd AS path, 'workspace' AS source FROM sessions WHERE cwd IS NOT NULL AND cwd != '' LIMIT 200").all(), supported: true };
  }) ?? { rows: [], supported: false };
}
