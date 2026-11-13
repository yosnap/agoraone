import { useCallback, useEffect, useState } from 'react';
import { getHermesActivity, getHermesCatalog, getHermesSummary, type HermesSummary } from '../api/client';
import { getCoreSummary, getEngines, type CoreSummary } from '../api/core';
import type { HermesActivity } from '../../shared/hermes-activity';
import type { HermesCatalog } from '../../shared/hermes-catalog';

export type Summary = {
  core: CoreSummary | null; hermes: HermesSummary | null; activity: HermesActivity | null; catalog: HermesCatalog | null;
  engine: { active: string | null; model: string } | null; errors: string[]; readAt: number;
};

const empty: Summary = { core: null, hermes: null, activity: null, catalog: null, engine: null, errors: [], readAt: 0 };

/** Everything the summary shows, read together every minute while it is on screen. Each source may fail on
 * its own: the rest still shows, and the failure is said. */
export function useSummary(discreet: boolean) {
  const [summary, setSummary] = useState<Summary>(empty);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const [core, hermes, activity, catalog, engine] = await Promise.allSettled([
        getCoreSummary(discreet), getHermesSummary(), getHermesActivity(), getHermesCatalog(), getEngines(),
      ]);
      if (!live) return;
      const errors = [
        core.status === 'rejected' && 'el núcleo', hermes.status === 'rejected' && 'el consumo de Hermes',
        activity.status === 'rejected' && 'la actividad de Hermes', engine.status === 'rejected' && 'los motores',
      ].filter((item): item is string => !!item);
      const value = <T,>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null;
      setSummary({ core: value(core), hermes: value(hermes), activity: value(activity), catalog: value(catalog), engine: value(engine), errors, readAt: Date.now() });
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [discreet, version]);
  return { summary, reload };
}

/** «2 h 14 min», counting from when the core started. */
export function uptime(startedAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${rest} min` : `${rest} min`;
}

export const compact = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)} mil M` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} M`
  : value >= 1e3 ? `${(value / 1e3).toFixed(1)} mil` : String(value);

/** Profiles with at least one platform connected right now, by the gateway's own state. */
export function connectedAgents(summary: Summary) {
  return (summary.catalog?.profiles ?? []).flatMap(profile => {
    const platforms = summary.activity?.profiles[profile.id]?.platforms.filter(link => link.state === 'connected').map(link => link.name) ?? [];
    return platforms.length ? [{ id: profile.id, label: profile.label, color: profile.color, platforms, last: summary.activity?.profiles[profile.id]?.lastActivityAt ?? null }] : [];
  });
}
