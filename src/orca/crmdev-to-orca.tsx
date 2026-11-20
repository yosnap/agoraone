import { useRef, useState } from 'react';
import { getProjectLinks, type ProjectLinks } from '../api/clients';
import type { OrcaProject } from '../api/core';
import { OrcaLaunch } from './orca-launch';
import { useOrcaProjects } from './orca-projects';

/** For each CRMDev project linked with a Central project whose repository is in Orca, that Orca project. Empty while
 * Orca is off or not installed, so no button shows. The links are read once per view. */
export function useCrmdevOrca(): Map<string, OrcaProject> {
  const orca = useOrcaProjects();
  const [links, setLinks] = useState<ProjectLinks | null>(null);
  const asked = useRef(false);
  if (!asked.current && orca.length) { asked.current = true; void getProjectLinks().then(setLinks).catch(() => undefined); }
  const found = new Map<string, OrcaProject>();
  if (!links) return found;
  for (const theirs of links.crmdev) {
    const mine = theirs.centralId ? links.central.find(p => p.id === theirs.centralId) : undefined;
    const choice = mine ? orca.find(o => o.project === mine.name && o.client === (mine.client ?? '')) : undefined;
    if (choice) found.set(theirs.id, choice);
  }
  return found;
}

/** The launch card under a task's or ticket's row: its linked project only, the record as data (the core reads it
 * from CRMDev and checks the link again) and the user's own task, editable; nothing runs before «Lanzar en Orca». */
export function CrmdevOrcaRow({ kind, id, title, choice, columns, onClose }: {
  kind: 'crmdev_task' | 'crmdev_ticket'; id: string; title: string | null; choice: OrcaProject; columns: number; onClose: () => void;
}) {
  const task = kind === 'crmdev_task'
    ? `Resuelve la tarea de CRMDev «${title ?? ''}». Antes de cambiar nada, explica tu plan.`
    : `Investiga y resuelve el ticket de CRMDev «${title ?? ''}». Antes de cambiar nada, explica tu plan.`;
  return <tr className="crmdev-orca-row"><td colSpan={columns}>
    <OrcaLaunch choices={[choice]} client={choice.client} project={choice.project} source={{ kind, remote: id }} task={task} onClose={onClose}/>
  </td></tr>;
}
