// Real Hermes activity, read-only metadata. Never message content, prompts, chat IDs or session titles.
export type PlatformLink = { name: string; state: 'connected' | 'retrying' | 'attention' | 'disconnected' | 'unknown'; updatedAt: string | null };
export type ScheduledJob = {
  id: string | null; name: string; enabled: boolean; state: string; schedule: string;
  lastStatus: string | null; lastRunAt: string | null; nextRunAt: string | null;
};
export type ToolUse = { name: string; calls: number; lastUsedAt: string | null };
/** Recorded tool calls (names and times only). `calls` counts the last `windowDays` days. */
export type ToolUsage = { windowDays: number; tools: ToolUse[]; mcp: (ToolUse & { tools: ToolUse[] })[] };
/** One entry of the activity log (last 24 h): times, origins and names only. */
export type ActivityEvent =
  | { at: string; kind: 'session'; source: string }
  | { at: string; kind: 'job'; name: string; status: string | null }
  | { at: string; kind: 'mcp'; server: string; calls: number }
  | { at: string; kind: 'link'; name: string; state: PlatformLink['state'] };
export type ProfileActivity = {
  platforms: PlatformLink[];
  lastActivityAt: string | null;
  /** Sessions with recorded activity in the last 24 h, by origin (telegram, desktop, cron…). */
  recent: { source: string; sessions: number }[];
  jobs: ScheduledJob[] | null;
  usage: ToolUsage | null;
  board: { byStatus: { status: string; count: number }[]; open: { id: string | null; title: string; status: string }[] } | null;
  events: ActivityEvent[];
};
export type HermesActivity = {
  schema: 1; readAt: string;
  gateway: { state: 'running' | 'stopped' | 'stale' | 'missing'; detail: string | null; updatedAt: string | null; activeAgents: number | null };
  profiles: Record<string, ProfileActivity>;
};
/** Activity this recent is shown as "actividad registrada" in the world. */
export const recentActivityMs = 2 * 60 * 1000;
/** The activity log covers this window. */
export const eventWindowMs = 24 * 60 * 60 * 1000;

/** Hermes registers MCP tools as `mcp__<server>__<tool>`, with non-alphanumerics in the server name replaced by `_`. */
export const mcpServerKey = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');
