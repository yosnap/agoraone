import { useCallback, useEffect, useState } from 'react';
import { getHermesActivity } from '../api/client';
import type { HermesActivity } from '../../shared/hermes-activity';

const refreshMs = 15_000;

/** Polls Hermes' own activity records; a failed read clears them rather than showing old data as current. */
export function useHermesActivity(csrf: string | undefined) {
  const [activity, setActivity] = useState<HermesActivity | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  /** Reads again now, after the user changed a task or card. */
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    if (!csrf) return;
    let live = true;
    const refresh = () => getHermesActivity().then(data => { if (live) { setActivity(data); setError(false); } })
      .catch(() => { if (live) { setActivity(null); setError(true); } });
    void refresh();
    const timer = setInterval(() => { if (!window.document.hidden) void refresh(); }, refreshMs);
    return () => { live = false; clearInterval(timer); };
  }, [csrf, version]);
  return { activity, error, reload };
}
