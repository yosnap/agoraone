import { request } from './client';
import type { OrcaSource } from './core';

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

/** «Encargar» (the bot takes it over) or «Preguntar» (it answers). */
export type BotErrandKind = 'handoff' | 'question';
export type BotErrandRequest = { client: string; project: string; task: string; bot: string; kind: BotErrandKind; source?: OrcaSource };
/** Exactly what will go: to a new chat of the bot, from AgoraOne's mailbox. */
export type BotErrandPreview = { id: string; bot: { id: string; name: string; agent: string | null }; kind: BotErrandKind; kindLabel: string;
  client: string; project: string; repo: string; orcaName: string; source: { kind: string; label: string } | null; subject: string; body: string };
export const previewBotErrand = (errand: BotErrandRequest) => request<BotErrandPreview>('/core/orca/bots/preview', errand);
export const sendBotErrand = (id: string) => request<{ messageId: string; bot: string; kind: BotErrandKind }>('/core/orca/bots/send', { id });
