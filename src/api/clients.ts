import { request } from './client';

// The user's clients through the core (/api/core/clients*): one directory with Central's, CRMDev's and the ones kept
// in AgoraOne. The list never carries an address, phone, tax id nor notes; only a client kept here, asked by its id
// for its form, comes whole.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

/** Only about Central and AgoraOne, as it always was; `sources` says every source of the entry. */
export type ClientSource = 'central' | 'local' | 'ambos';
export type ClientOrigin = 'central' | 'crmdev' | 'local';
export type ClientProject = { name: string; status: string | null; phase: string | null; repo: string | null };
export type DirectoryClient = {
  name: string; company: string | null; domains: string[]; projects: ClientProject[]; websites: { url: string; status: string | null }[];
  source: ClientSource; localId: number | null; centralId: string | null; aliases: string[];
  sources: ClientOrigin[]; crmdevId: string | null; crmdevStatus: string | null;
  /** Fields CRMDev has otherwise than Central (an address only says that it differs: its value is not in the list). */
  differences: { field: string; label: string; crmdev?: string }[];
  /** Kept only in AgoraOne while a CRM is connected, and linked to none: to be created or linked in one. */
  unplaced: boolean;
  /** Linked with a client that CRM no longer returns: «sin ubicar» again. */
  staleLink: 'central' | 'crmdev' | null;
  /** People of CRMDev whose company is this client (never their address); `crmdevStatus` is the most advanced of all. */
  contacts: { id: string; name: string; status: string | null }[];
  /** Another entry has the same name (two clients of a CRM called the same): the user decides with «Enlazar». */
  repeated: boolean;
};
/** Two clients of different sources whose names are only alike: linked only on «Enlazar». */
export type LinkSuggestion =
  | { localId: number; localName: string; centralId: string; centralName: string }
  | { localId: number; localName: string; crmdevId: string; crmdevName: string }
  | { centralId: string; centralName: string; crmdevId: string; crmdevName: string };
export type DistinctPair = { centralId: string; centralName: string | null; crmdevId: string; crmdevName: string | null };
/** A vault note «Clientes/<Nombre>» (or a folder «Clientes/<Nombre>/») whose name is no client of the directory. */
export type VaultCard = { name: string; level: 'normal' | 'local_only' | 'private'; notes: number };
export type ClientsDirectory = {
  clients: DirectoryClient[]; suggestions: LinkSuggestion[]; distinctPairs: DistinctPair[]; unplacedCount: number;
  central: { on: boolean; read: boolean };
  crmdev: { on: boolean; connected: boolean; read: boolean; fetchedAt: string | null; truncated: boolean; problem: string | null };
  /** In discreet mode only normal cards are named; the others are only counted (`hidden`). */
  vaultCards: { cards: VaultCard[]; count: number; hidden: number };
};
export type OwnClientFields = { name: string; company: string | null; email: string | null; phone: string | null; taxId: string | null; domains: string[]; notes: string | null };
export type OwnClient = OwnClientFields & {
  localId: number; centralId: string | null; centralName: string | null; createdAt: string; updatedAt: string;
  /** The Central clients the user said are different ones («Son distintos»), undoable from the form. */
  distinct: { centralId: string; centralName: string | null }[];
  /** Its links with other connectors' clients (CRMDev): linked, or said to be different (undoable). */
  links: { connector: 'crmdev'; remoteId: string; remoteName: string | null; state: 'linked' | 'distinct' }[];
  /** What keeps the client's name: a rename goes with it; a deletion leaves them with the old name. */
  references: { meetings: number };
};

export const sourceLabels: Record<ClientSource, string> = { central: 'Central', local: 'Propio', ambos: 'Propio y Central' };
export const originLabels: Record<ClientOrigin, string> = { central: 'Central', crmdev: 'CRMDev', local: 'AgoraOne' };

export const getClients = (discreet = false) => core<ClientsDirectory>(`/clients${discreet ? '?discreet=true' : ''}`);
export const getClient = (id: number) => core<OwnClient>(`/clients/${id}`);
export const createClient = (fields: OwnClientFields) => core<OwnClient>('/clients', fields);
export const updateClient = (id: number, fields: Partial<OwnClientFields>) => core<OwnClient>(`/clients/${id}`, fields, 'PATCH');
/** Deletes a client kept here; the core keeps a copy of it first. */
export const deleteClient = (id: number) => core<{ deleted: true; references: { meetings: number } }>(`/clients/${id}`, undefined, 'DELETE');
/** «Enlazar»: the user confirmed this client and that one of Central's are the same. */
export const linkClient = (id: number, centralId: string) => core<OwnClient>(`/clients/${id}/link`, { centralId });
/** «Son distintos»: never linked nor suggested with that one of Central's again (also undoes a link). */
export const distinctClient = (id: number, centralId: string) => core<OwnClient>(`/clients/${id}/distinct`, { centralId });
/** Undoes a «Son distintos»: that pair may be linked or suggested again. */
export const undistinctClient = (id: number, centralId: string) => core<OwnClient>(`/clients/${id}/undistinct`, { centralId });
/** «Enlazar», «Son distintos» or undoing it between a client kept here and one of CRMDev's. */
export const linkCrmdevClient = (id: number, remoteId: string, state: 'linked' | 'distinct' | 'undistinct') =>
  core<OwnClient>(`/clients/${id}/link`, { connector: 'crmdev', remoteId, state });
/** The same between one of Central's clients and one of CRMDev's, without a client kept here. */
export const linkClientPair = (centralId: string, crmdevId: string, state: 'linked' | 'distinct' | 'undistinct') =>
  core<{ done: true }>('/clients/pairs', { centralId, crmdevId, state });

/** Central's and CRMDev's projects, each with its pair: linked by the user (`user`) or by the same unique name (`name`). */
export type LinkedCentralProject = { id: string; name: string; client: string | null; kind: string | null; status: string | null; repo: string | null;
  crmdevId: string | null; how: 'user' | 'name' | null };
export type LinkedCrmdevProject = { id: string; name: string; status: string | null; type: string | null; clientId: string | null;
  centralId: string | null; how: 'user' | 'name' | null };
export type ProjectPairHint = { centralId: string; centralName: string | null; crmdevId: string; crmdevName: string | null };
export type ProjectLinks = { central: LinkedCentralProject[]; crmdev: LinkedCrmdevProject[]; suggestions: ProjectPairHint[]; distinct: ProjectPairHint[] };
export const getProjectLinks = () => core<ProjectLinks>('/project-links');
/** «Enlazar», «Son distintos» or undoing either between one of Central's projects and one of CRMDev's. */
export const setProjectLink = (centralId: string, crmdevId: string, state: 'linked' | 'distinct' | 'unlinked') =>
  core<{ done: true }>('/project-links', { centralId, crmdevId, state });
