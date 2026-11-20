// The tab another section asks Trabajos to open with (Central's «Ver mis clientes»), taken once by Trabajos.
export type JobsTab = 'work' | 'clients';
let requested: JobsTab | null = null;

export function openJobsTab(tab: JobsTab) { requested = tab; }

export function takeJobsTab(): JobsTab {
  const tab = requested ?? 'work';
  requested = null;
  return tab;
}

// The filter the directory of clients opens with (the Resumen's «Ver sin ubicar»), taken once by the directory.
export type ClientsFilterRequest = 'all' | 'unplaced' | 'cards' | 'pending' | 'births';
let filterRequested: ClientsFilterRequest | null = null;

export function openClientsFilter(filter: ClientsFilterRequest) { requested = 'clients'; filterRequested = filter; }

export function takeClientsFilter(): ClientsFilterRequest {
  const filter = filterRequested ?? 'all';
  filterRequested = null;
  return filter;
}
