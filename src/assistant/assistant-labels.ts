import type { AssistantEvent } from '../api/core';
export const engineLabels: Record<string, string> = {
  'claude-code': 'Claude Code (tu sesión)', quick: 'una orden rápida, sin modelo', 'anthropic-api': 'API de Anthropic', compatible: 'Proveedor compatible',
};
export const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
export const stageLabels = { recuerda: 'Recordando en tu cerebro…', web: 'Leyendo la página…', piensa: 'Pensando…', responde: 'Respondiendo…' } as const;

export const engineName = (engine?: string | null) => (engine && engineLabels[engine]) || engine || 'motor desconocido';
export const modelName = (model?: string | null) => (model && modelLabels[model]) || model || '';

/** The step a Bandeja lookup leaves in the chat: how many mails and, with WhatsApp on, how many conversations. */
export const inboxStep = (mails: number, chats?: number) =>
  `Consultó la Bandeja · ${mails} ${mails === 1 ? 'correo' : 'correos'}${chats === undefined ? '' : ` y ${chats} WhatsApp`}`;

/** What the core read from the addresses in the message: the sites only, never the full address. */
export const webLabel = (pages: { host: string; ok: boolean }[]) => {
  const read = pages.filter(page => page.ok).map(page => page.host);
  if (!read.length) return pages.length === 1 ? 'No se pudo leer la página' : 'No se pudo leer ninguna página';
  const failed = pages.length - read.length;
  return `Leído: ${read.join(', ')}${failed ? ` · ${failed} sin leer` : ''}`;
};

/** One line of what Watson did, for the steps shown under its answer. */
export const toolStep = (event: Extract<AssistantEvent, { kind: 'tool' }>): string =>
  event.tool === 'search' ? `Buscó «${event.query}» · ${event.found.length} notas` : event.tool === 'inbox' ? inboxStep(event.count, event.chats) : event.tool === 'clients' ? `Consultó los clientes de Central · ${event.count}` : event.tool === 'meetings' ? `Buscó en las reuniones · ${event.count}` : event.tool === 'meeting' ? `Leyó la reunión «${event.title}»` : event.tool === 'rule_proposal' ? `Propuso la regla «${event.rule.name}»` : event.tool === 'note_proposal' ? `Propuso la nota «${event.note.title}»` : event.tool === 'event_proposal' ? `Propuso el evento «${event.event.title}»` : event.tool === 'quote_proposal' ? `Propuso el presupuesto «${event.quote.title}»` : event.tool === 'issue_proposal' ? `Propuso una issue en ${event.issue.repo}` : event.tool === 'orca_proposal' ? `Propuso llevar un encargo a Orca en ${event.proposal.repo}` : event.tool === 'hermes_proposal' ? `Propuso un encargo para ${event.proposal.profile} (Hermes)` : event.tool === 'chat_reply_proposal' ? 'Propuso una respuesta de WhatsApp' : event.tool === 'cleanup_proposal' ? `Preparó ${event.messages.length} correos para ${event.action === 'trash' ? 'la Papelera' : 'archivar'}` : event.tool === 'reorg_proposal' ? `Propuso ${event.moves.length} cambios para ordenar el vault` : event.tool === 'vault_outline' ? `Revisó el vault · ${event.notes} notas en ${event.folders} carpetas` : event.tool === 'read' ? `Leyó [${event.n}] ${event.title}` : 'Consultó tus datos';
