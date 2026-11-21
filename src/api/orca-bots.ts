import { request } from './client';

// Orca's bots (1.9): the user's bots in Orca, one per kind of job, and AgoraOne's mailbox in Orca (a terminal of its
// own running `cat`), from which errands go to them and where their answers arrive. AgoraOne never creates nor sets up
// a bot: that is done in Orca.

export type OrcaBot = { id: string; name: string; agent: string | null; purpose: string | null; paused: boolean };
/** `ready`: errands can go; `missing`: never created or gone; `broken`: `cat` no longer runs in it. */
export type OrcaMailbox = { state: 'ready' | 'missing' | 'broken'; title: string; where?: string | null; problem?: string };
export type OrcaBots = { on: boolean; bots: OrcaBot[]; mailbox: OrcaMailbox | null; problem: string | null };

export const getOrcaBots = () => request<OrcaBots>('/core/orca/bots');
/** «Crear el buzón de AgoraOne»: a new visible tab in Orca; only with the button. */
export const createOrcaMailbox = () => request<OrcaMailbox>('/core/orca/mailbox', {});
