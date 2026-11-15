// What GET /api/hermes/work returns (desktop/server/src/hermes/work.rs): every profile's scheduled tasks
// and the shared kanban board, with their runs, time and tokens. Metadata only.
export type WorkTokens = { input: number; output: number; costUsd: number | null };
export type WorkTotals = Record<'24h' | '7d' | '30d', { runs: number; seconds: number; measured: number; tokens: WorkTokens }>;
export type WorkRun = { startedAt: string | null; finishedAt: string | null; status: string | null; seconds: number | null; tokens: WorkTokens | null };
export type WorkTask = {
  id: string | null; name: string; enabled: boolean; state: string; schedule: string; lastStatus: string | null;
  lastRunAt: string | null; nextRunAt: string | null; runs: WorkRun[]; totals: WorkTotals;
};
export type CardRun = { profile: string | null; status: string | null; outcome: string | null; startedAt: string | null; endedAt: string | null; seconds: number | null };
export type WorkCard = {
  id: string | null; board: string; title: string; assignee: string | null; profileId: string | null; status: string; priority: number; createdBy: string | null;
  createdAt: string | null; startedAt: string | null; completedAt: string | null; runs: CardRun[]; seconds: number | null; tokens: WorkTokens | null; totals: WorkTotals;
};
export type HermesWork = {
  schema: 1; readAt: string;
  profiles: Record<string, { name: string; tasks: WorkTask[] | null }>;
  board: { cards: WorkCard[] } | null;
};
