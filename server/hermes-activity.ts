import { join } from 'node:path';
import { statSync } from 'node:fs';
import { eventWindowMs, mcpServerKey, type ActivityEvent, type HermesActivity, type PlatformLink, type ProfileActivity, type ScheduledJob, type ToolUsage, type ToolUse } from '../shared/hermes-activity';
import { readHermesFile, redact } from './hermes-safe-read';
import { withHermesDatabase } from './hermes-database';
import { activityLog, iso, jobRuns } from './hermes-activity-log';

// Hermes itself treats its runtime status as stale after 120 s (gateway/status.py).
const staleAfterMs = 120_000;
const word = /^[a-z][a-z0-9_-]{0,31}$/;

const json = (root: string, file: string, limit = 256 * 1024): Record<string, any> | null => {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readHermesFile(root, file, limit)));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
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
    const started = db.prepare('SELECT source, started_at FROM sessions WHERE started_at > ? ORDER BY started_at DESC LIMIT 30').all((now - eventWindowMs) / 1000)
      .flatMap(row => token(row.source) && iso(row.started_at) ? [{ at: iso(row.started_at)!, kind: 'session' as const, source: row.source as string }] : []);
    return { lastActivityAt: iso(last), recent, started };
  });
}

const usageDays = 30;
const toolName = /^[A-Za-z0-9_-]{1,96}$/;
// state.db only changes when its file or WAL changes; reuse the aggregate meanwhile (10-minute window granularity).
type ToolRecords = { usage: ToolUsage; mcpHours: ActivityEvent[] };
const usageCache = new Map<string, { key: string; value: ToolRecords | null }>();
const fileStamp = (file: string) => { try { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } };

/** Splits `mcp__<server>__<tool>` using the declared server keys first, so names containing `__` resolve correctly. */
function splitMcp(name: string, declared: string[]) {
  const key = declared.find(server => name.startsWith(`mcp__${server}__`));
  if (key) return [key, name.slice(key.length + 7)];
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  return match ? [match[1], match[2]] : null;
}

function toolRecords(root: string, home: string, declaredNames: string[], now: number): ToolRecords | null {
  const file = join(home, 'state.db');
  const declared = declaredNames.map(mcpServerKey).sort((a, b) => b.length - a.length);
  const key = [fileStamp(file), fileStamp(`${file}-wal`), Math.floor(now / 600_000), declared.join(',')].join('|');
  const cached = usageCache.get(file);
  if (cached?.key === key) return cached.value;
  const value = withHermesDatabase(root, file, (db, columns) => {
    const c = columns('messages');
    if (!['tool_name', 'timestamp', 'role'].every(column => c.has(column))) return null;
    // Compaction leaves cloned rows behind: count each call once by its call ID when Hermes records it.
    const call = c.has('tool_call_id') && c.has('session_id') ? "session_id || '|' || coalesce(tool_call_id, rowid)" : 'rowid';
    // Tool names and call times only: never arguments, results or message content.
    const rows = db.prepare(`SELECT tool_name AS name, count(DISTINCT CASE WHEN timestamp > ? THEN ${call} END) AS calls, max(timestamp) AS last FROM messages WHERE role = 'tool' AND tool_name IS NOT NULL AND tool_name != '' GROUP BY tool_name LIMIT 500`)
      .all((now - usageDays * 86_400_000) / 1000)
      .flatMap(row => typeof row.name === 'string' && toolName.test(row.name) ? [{ name: row.name, calls: Number(row.calls) || 0, lastUsedAt: iso(row.last) }] : []);
    const byRecent = (a: ToolUse, b: ToolUse) => b.calls - a.calls || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt));
    const servers = new Map<string, ToolUse[]>();
    const tools: ToolUse[] = [];
    for (const row of rows) {
      const mcp = splitMcp(row.name, declared);
      if (!mcp) { tools.push(row); continue; }
      if (!servers.has(mcp[0])) servers.set(mcp[0], []);
      servers.get(mcp[0])!.push({ ...row, name: mcp[1] });
    }
    const mcp = [...servers].map(([name, list]) => ({
      name, calls: list.reduce((sum, item) => sum + item.calls, 0),
      lastUsedAt: list.map(item => item.lastUsedAt).filter(Boolean).sort().at(-1) ?? null,
      tools: list.sort(byRecent).slice(0, 12),
    })).sort(byRecent).slice(0, 30);
    // Activity log: MCP calls of the last 24 h grouped by server and hour.
    const hours = new Map<string, { at: string; kind: 'mcp'; server: string; calls: number }>();
    for (const row of db.prepare(`SELECT tool_name AS name, CAST(timestamp / 3600 AS INTEGER) AS hour, count(DISTINCT ${call}) AS calls, max(timestamp) AS last FROM messages WHERE role = 'tool' AND tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND timestamp > ? GROUP BY tool_name, hour`).all((now - eventWindowMs) / 1000)) {
      const server = typeof row.name === 'string' && toolName.test(row.name) ? splitMcp(row.name, declared)?.[0] : undefined;
      const at = iso(row.last);
      if (!server || !at) continue;
      const slot = `${server}|${row.hour}`, entry = hours.get(slot);
      if (!entry) hours.set(slot, { at, kind: 'mcp', server, calls: Number(row.calls) || 0 });
      else { entry.calls += Number(row.calls) || 0; if (at > entry.at) entry.at = at; }
    }
    return { usage: { windowDays: usageDays, tools: tools.sort(byRecent).slice(0, 12), mcp }, mcpHours: [...hours.values()] };
  });
  usageCache.set(file, { key, value });
  return value;
}

function rawJobs(root: string, home: string): Record<string, unknown>[] | null {
  const data = json(root, join(home, 'cron', 'jobs.json'), 1024 * 1024);
  if (!data) return null;
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [];
  return list.slice(0, 20).flatMap(job => job && typeof job === 'object' ? [job as Record<string, unknown>] : []);
}

function jobs(list: Record<string, unknown>[] | null): ScheduledJob[] | null {
  if (!list) return null;
  // Name and schedule only; the job prompt, origin and delivery target are never read.
  return list.map(job => ({
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
export function readActivity(root: string, profiles: { id: string; name: string; home: string; mcp?: string[] }[], now = Date.now()): HermesActivity {
  const live = attempt(() => gateway(root, now), { info: { state: 'missing', detail: null, updatedAt: null, activeAgents: null } as HermesActivity['gateway'], state: null, fresh: false });
  const result: HermesActivity = { schema: 1, readAt: new Date(now).toISOString(), gateway: live.info, profiles: {} };
  for (const profile of profiles) {
    const recorded = attempt(() => sessions(root, profile.home, now), null);
    const tools = attempt(() => toolRecords(root, profile.home, profile.mcp ?? [], now), null);
    const jobList = attempt(() => rawJobs(root, profile.home), null);
    const links = platforms(live.state, live.fresh, profile.name);
    result.profiles[profile.id] = {
      platforms: links,
      lastActivityAt: recorded?.lastActivityAt ?? null, recent: recorded?.recent ?? [],
      usage: tools?.usage ?? null,
      jobs: jobs(jobList),
      board: attempt(() => board(root, profile.name), null),
      events: activityLog(now, [
        recorded?.started ?? [], tools?.mcpHours ?? [],
        attempt(() => jobRuns(root, profile.home, jobList ?? [], now), []),
        links.flatMap(link => link.updatedAt ? [{ at: link.updatedAt, kind: 'link' as const, name: link.name, state: link.state }] : []),
      ]),
    };
  }
  return result;
}
