// Real Hermes activity, read-only metadata. Never message content, prompts, chat IDs or session titles.
export type PlatformLink = { name: string; state: 'connected' | 'retrying' | 'attention' | 'disconnected' | 'unknown'; updatedAt: string | null };
export type ScheduledJob = {
  name: string; enabled: boolean; state: string; schedule: string;
  lastStatus: string | null; lastRunAt: string | null; nextRunAt: string | null;
};
export type ToolUse = { name: string; calls: number; lastUsedAt: string | null };
/** Recorded tool calls (names and times only). `calls` counts the last `windowDays` days. */
export type ToolUsage = { windowDays: number; tools: ToolUse[]; mcp: (ToolUse & { tools: ToolUse[] })[] };
export type ProfileActivity = {
  platforms: PlatformLink[];
  lastActivityAt: string | null;
  /** Sessions with recorded activity in the last 24 h, by origin (telegram, desktop, cron…). */
  recent: { source: string; sessions: number }[];
  jobs: ScheduledJob[] | null;
  usage: ToolUsage | null;
  board: { byStatus: { status: string; count: number }[]; open: { title: string; status: string }[] } | null;
};
export type HermesActivity = {
  schema: 1; readAt: string;
  gateway: { state: 'running' | 'stopped' | 'stale' | 'missing'; detail: string | null; updatedAt: string | null; activeAgents: number | null };
  profiles: Record<string, ProfileActivity>;
};
/** Activity this recent is shown as "actividad registrada" in the world. */
export const recentActivityMs = 2 * 60 * 1000;

/** Hermes registers MCP tools as `mcp__<server>__<tool>`, with non-alphanumerics in the server name replaced by `_`. */
export const mcpServerKey = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');
