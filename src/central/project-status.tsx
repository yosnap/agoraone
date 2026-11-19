import { projectStatusLabels } from '../api/central';

const TONE: Record<string, string> = { ACTIVE: 'good', MAINTENANCE: 'waiting', DORMANT: 'paused', ARCHIVED: 'neutral' };

/** A Central project's state as a coloured badge with its icon: active, maintenance, stopped or archived. */
export function ProjectStatus({ status }: { status: string | null }) {
  if (!status) return <span>—</span>;
  return <span className={`status-badge ${TONE[status] ?? 'neutral'}`}>{projectStatusLabels[status] ?? status}</span>;
}
