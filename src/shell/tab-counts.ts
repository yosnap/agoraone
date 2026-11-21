import { useRef, useState } from 'react';
import { request } from '../api/client';

/** How many there are in each tab, from what AgoraOne keeps (the core never asks Central nor CRMDev for this). */
export type CrmdevCounts = { clientes: number; clientesMore: boolean; proyectos: number; proyectosMore: boolean;
  tareas: number | null; tareasMore: boolean; tickets: number | null; ticketsMore: boolean; central: number | null };
export type TabCounts = {
  clientes: number;
  central: { clientes: number; proyectos: number; webs: number; servidores: number; 'por-crear': number } | null;
  /** The first organization's; `crmdevOrgs`, each organization's (its «Desde Central» also counts what has none). */
  crmdev: CrmdevCounts | null;
  crmdevOrgs?: Record<string, CrmdevCounts>;
};

export const getTabCounts = () => request<TabCounts>('/core/tab-counts');

/** «Proyectos · 12», «Tareas · 100+» (CRMDev gives 100 at most) or just the label when the number is not known. */
export function withCount(label: string, n: number | null | undefined, more = false): string {
  return typeof n === 'number' ? `${label} · ${n}${more ? '+' : ''}` : label;
}

/** The counters, read once when the tabs are shown (and again with `reload`, after a reading or a change). */
export function useTabCounts(): { counts: TabCounts | null; reload: () => void } {
  const [counts, setCounts] = useState<TabCounts | null>(null);
  const asked = useRef(false);
  const reload = () => { void getTabCounts().then(setCounts).catch(() => undefined); };
  if (!asked.current) { asked.current = true; reload(); }
  return { counts, reload };
}
