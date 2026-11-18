// The tab another section asks Trabajos to open with (Central's «Ver mis clientes»), taken once by Trabajos.
export type JobsTab = 'work' | 'clients';
let requested: JobsTab | null = null;

export function openJobsTab(tab: JobsTab) { requested = tab; }

export function takeJobsTab(): JobsTab {
  const tab = requested ?? 'work';
  requested = null;
  return tab;
}
