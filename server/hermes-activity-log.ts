import { join } from 'node:path';
import { eventWindowMs, type ActivityEvent } from '../shared/hermes-activity';
import { redact } from './hermes-safe-read';
import { withHermesDatabase } from './hermes-database';

const word = /^[a-z][a-z0-9_-]{0,31}$/;
/** Hermes timestamps: epoch seconds (state.db, legacy records) or ISO strings with offset. */
export const iso = (value: unknown) => {
  const date = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/** Scheduled-job runs of the last 24 h: Hermes' execution history plus each job's last run. Names and outcomes only. */
export function jobRuns(root: string, home: string, jobs: Record<string, unknown>[], now: number): ActivityEvent[] {
  const since = now - eventWindowMs;
  const names = new Map(jobs.map(job => [String(job.id), redact(job.name, 100) || 'Tarea sin nombre']));
  // The job ID only pairs history with jobs.json; it never leaves the backend.
  const runs: { jobId: string; event: ActivityEvent }[] = withHermesDatabase(root, join(home, 'cron', 'executions.db'), (db, columns) => {
    const c = columns('executions');
    if (!['job_id', 'status', 'started_at', 'finished_at'].every(key => c.has(key))) return [];
    // Never the error text, process details or delivery target.
    return db.prepare('SELECT job_id, status, started_at, finished_at FROM executions ORDER BY rowid DESC LIMIT 100').all().flatMap(row => {
      const at = iso(row.finished_at) ?? iso(row.started_at);
      if (!at || Date.parse(at) < since) return [];
      return [{ jobId: String(row.job_id), event: { at, kind: 'job' as const, name: names.get(String(row.job_id)) ?? 'Tarea programada', status: typeof row.status === 'string' && word.test(row.status) ? row.status : null } }];
    });
  }) ?? [];
  // jobs.json records the latest run even when the execution history does not; add it unless already listed.
  for (const job of jobs) {
    const at = iso(job.last_run_at);
    if (!at || Date.parse(at) < since) continue;
    const jobId = String(job.id);
    if (runs.some(run => run.jobId === jobId && Math.abs(Date.parse(run.event.at) - Date.parse(at)) < 10 * 60_000)) continue;
    runs.push({ jobId, event: { at, kind: 'job', name: names.get(jobId)!, status: typeof job.last_status === 'string' && word.test(job.last_status) ? job.last_status : null } });
  }
  return runs.map(run => run.event);
}

/** Merges a profile's events, newest first, keeping only the log window. */
export function activityLog(now: number, lists: ActivityEvent[][]): ActivityEvent[] {
  return lists.flat()
    .filter(event => { const at = Date.parse(event.at); return at >= now - eventWindowMs && at <= now + 60_000 && !(event.kind === 'link' && event.state === 'unknown'); })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30);
}
