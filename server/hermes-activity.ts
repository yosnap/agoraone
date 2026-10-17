import { join } from 'node:path';
import type { HermesActivity, PlatformLink, ProfileActivity, ScheduledJob } from '../shared/hermes-activity';
import { readHermesFile, redact } from './hermes-safe-read';
import { withHermesDatabase } from './hermes-database';

// Hermes itself treats its runtime status as stale after 120 s (gateway/status.py).
const staleAfterMs = 120_000;
const word = /^[a-z][a-z0-9_-]{0,31}$/;

const json = (root: string, file: string, limit = 256 * 1024): Record<string, any> | null => {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readHermesFile(root, file, limit)));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
};
const iso = (value: unknown) => {
  const date = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};
const token = (value: unknown) => typeof value === 'string' && word.test(value) ? value : null;
const alive = (pid: unknown) => {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

function gateway(root: string, now: number) {
  const state = json(root, join(root, 'gateway_state.json'));
  if (!state) return { info: { state: 'missing', detail: null, updatedAt: null, activeAgents: null } as HermesActivity['gateway'], state: null, fresh: false };
  const beat = json(root, join(root, 'state', 'gateway.heartbeat'), 4096);
  const stamps = [state.updated_at, beat?.pid === state.pid ? beat?.updated_at : null].map(value => Date.parse(String(value))).filter(Number.isFinite);
  const updated = stamps.length ? Math.max(...stamps) : NaN;
  const fresh = Number.isFinite(updated) && now - updated < staleAfterMs;
  const phase = token(state.gateway_state);
  const serving = phase === 'running' || phase === 'degraded';
  const running = alive(state.pid) && serving;
  const info: HermesActivity['gateway'] = {
    state: !alive(state.pid) ? 'stopped' : !fresh ? 'stale' : running ? 'running' : 'stopped',
    detail: phase && phase !== 'running' ? phase : null,
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
    activeAgents: running && fresh && Number.isInteger(state.active_agents) && state.active_agents >= 0 ? state.active_agents : null,
  };
  return { info, state, fresh: fresh && running };
}

function platforms(state: Record<string, any> | null, fresh: boolean, profile: string): PlatformLink[] {
  const entries = state?.platforms && typeof state.platforms === 'object' ? Object.entries(state.platforms as Record<string, any>) : [];
  return entries.flatMap(([key, value]) => {
    // Keys are "telegram" for the default profile and "<profile>:telegram" for the others.
    const [owner, name] = key.includes(':') ? key.split(':', 2) : ['default', key];
    if (owner !== profile || !token(name) || !value || typeof value !== 'object') return [];
    const raw = token(value.state);
    const linkState: PlatformLink['state'] = !fresh ? 'unknown' : value.needs_attention === true ? 'attention'
      : raw === 'connected' ? 'connected' : raw === 'retrying' || raw === 'connecting' ? 'retrying' : 'disconnected';
    return [{ name: name as string, state: linkState, updatedAt: iso(value.updated_at) }];
  }).slice(0, 20);
}

function sessions(root: string, home: string, now: number) {
  return withHermesDatabase(root, join(home, 'state.db'), (db, columns) => {
    const c = columns('sessions');
    if (!c.has('source') || !c.has('started_at')) return null;
    // Only timestamps and origin counts: no titles, content, prompts or chat identifiers.
    const at = c.has('last_activity_at') ? 'coalesce(last_activity_at, started_at)' : 'started_at';
    const last = db.prepare(`SELECT max(${at}) AS last FROM sessions`).get()?.last;
    const recent = db.prepare(`SELECT source, count(*) AS sessions FROM sessions WHERE ${at} > ? GROUP BY source ORDER BY sessions DESC LIMIT 12`).all((now - 86_400_000) / 1000)
      .flatMap(row => token(row.source) ? [{ source: row.source as string, sessions: Number(row.sessions) }] : []);
    return { lastActivityAt: iso(last), recent };
  });
}

function jobs(root: string, home: string): ScheduledJob[] | null {
  const data = json(root, join(home, 'cron', 'jobs.json'), 1024 * 1024);
  if (!data) return null;
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [];
  // Name and schedule only; the job prompt, origin and delivery target are never read.
  return list.slice(0, 20).flatMap(job => job && typeof job === 'object' ? [job as Record<string, unknown>] : []).map(job => ({
    name: redact(job.name, 100) || 'Tarea sin nombre', enabled: job.enabled === true, state: token(job.state) || 'unknown',
    schedule: redact(job.schedule_display, 80), lastStatus: token(job.last_status),
    lastRunAt: iso(job.last_run_at), nextRunAt: iso(job.next_run_at),
  }));
}

function board(root: string, profile: string): ProfileActivity['board'] {
  return withHermesDatabase(root, join(root, 'kanban.db'), (db, columns) => {
    const c = columns('tasks');
    if (!['title', 'assignee', 'status'].every(key => c.has(key))) return null;
    const byStatus = db.prepare('SELECT status, count(*) AS count FROM tasks WHERE assignee = ? GROUP BY status').all(profile)
      .flatMap(row => token(row.status) ? [{ status: row.status as string, count: Number(row.count) }] : []);
    const open = db.prepare("SELECT title, status FROM tasks WHERE assignee = ? AND status NOT IN ('done', 'archived') ORDER BY rowid DESC LIMIT 8").all(profile)
      .map(row => ({ title: redact(row.title, 120) || 'Tarea sin título', status: token(row.status) || 'unknown' }));
    return { byStatus, open };
  });
}

const attempt = <T>(read: () => T, fallback: T) => { try { return read(); } catch { return fallback; } };

/** Read-only snapshot of what Hermes records about its own activity. */
export function readActivity(root: string, profiles: { id: string; name: string; home: string }[], now = Date.now()): HermesActivity {
  const live = attempt(() => gateway(root, now), { info: { state: 'missing', detail: null, updatedAt: null, activeAgents: null } as HermesActivity['gateway'], state: null, fresh: false });
  const result: HermesActivity = { schema: 1, readAt: new Date(now).toISOString(), gateway: live.info, profiles: {} };
  for (const profile of profiles) {
    const recorded = attempt(() => sessions(root, profile.home, now), null);
    result.profiles[profile.id] = {
      platforms: platforms(live.state, live.fresh, profile.name),
      lastActivityAt: recorded?.lastActivityAt ?? null, recent: recorded?.recent ?? [],
      jobs: attempt(() => jobs(root, profile.home), null),
      board: attempt(() => board(root, profile.name), null),
    };
  }
  return result;
}
