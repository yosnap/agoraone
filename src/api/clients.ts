import { request } from './client';

// The user's clients through the core (/api/core/clients*): one directory with Central's and the ones kept in
// AgoraOne. The list never carries an address, phone, tax id nor notes; only a client kept here, asked by its id
// for its form, comes whole.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type ClientSource = 'central' | 'local' | 'ambos';
export type ClientProject = { name: string; status: string | null; phase: string | null; repo: string | null };
export type DirectoryClient = {
  name: string; company: string | null; domains: string[]; projects: ClientProject[]; websites: { url: string; status: string | null }[];
  source: ClientSource; localId: number | null; centralId: string | null; aliases: string[];
};
export type LinkSuggestion = { localId: number; localName: string; centralId: string; centralName: string };
export type ClientsDirectory = { clients: DirectoryClient[]; suggestions: LinkSuggestion[]; central: { on: boolean; read: boolean } };
export type OwnClientFields = { name: string; company: string | null; email: string | null; phone: string | null; taxId: string | null; domains: string[]; notes: string | null };
export type OwnClient = OwnClientFields & {
  localId: number; centralId: string | null; centralName: string | null; createdAt: string; updatedAt: string;
  /** The Central clients the user said are different ones («Son distintos»), undoable from the form. */
  distinct: { centralId: string; centralName: string | null }[];
  /** What keeps the client's name: a rename goes with it; a deletion leaves them with the old name. */
  references: { meetings: number };
};

export const sourceLabels: Record<ClientSource, string> = { central: 'Central', local: 'Propio', ambos: 'Propio y Central' };

export const getClients = () => core<ClientsDirectory>('/clients');
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
