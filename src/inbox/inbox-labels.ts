import type { InboxItem, InboxKind, MailRuleAction } from '../api/core';

export const kindLabels: Record<InboxKind, string> = {
  invoice: 'Factura', payment: 'Pago', job: 'Oferta de trabajo', client: 'Cliente', incident: 'Incidencia',
  appointment: 'Cita', personal: 'Personal', important: 'Importante', advertising: 'Publicidad', other: 'Otro',
};

const phrases: Record<InboxKind, string> = {
  invoice: 'una factura', payment: 'un aviso de pago', job: 'una oferta de trabajo', client: 'una petición de cliente', incident: 'una incidencia',
  appointment: 'una cita', personal: 'un correo personal', important: 'un correo importante', advertising: 'publicidad', other: 'un correo',
};

export const actionLabels: Record<MailRuleAction, string> = {
  invoice: 'Factura de proveedor', client: 'Cliente o proyecto', personal: 'Personal', important: 'Importante', ignore: 'Ignorar',
};

// What the Bandeja proposes; the actions themselves arrive in later phases of 1.1 and say so.
export const proposalLabels: Record<NonNullable<InboxItem['proposal']>, { label: string; question: string; arrives: string }> = {
  archive_invoice: { label: 'Descargar y archivar la factura', question: '¿la descargo y la archivo en su trimestre?', arrives: '' },
  add_to_project: { label: 'Añadir a la nota del proyecto', question: '¿lo añado a la nota de su proyecto?', arrives: '' },
  create_event: { label: 'Crear el evento', question: '¿creo el evento en tu calendario?', arrives: '' },
};

export const sender = (item: InboxItem) => item.from.name || item.from.address || 'remitente desconocido';

export function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Watson's sentence for a pending card: what arrived and what it proposes. */
export function announcement(item: InboxItem) {
  const amount = item.details.amounts?.[0] ? ` (${item.details.amounts[0]})` : '';
  const proposal = item.proposal ? proposalLabels[item.proposal] : null;
  return `Tienes ${phrases[item.kind]} de ${sender(item)}${amount}${proposal ? `: ${proposal.question}` : '.'}`;
}

/** What a mail taken to Orca asks the agent by default; the user changes it before the preview. The mail's own
 * words never go here: they travel below, marked as data. */
export const orcaTask = 'Lee el correo del cliente que va debajo y resuelve en este repositorio lo que pide. Antes de cambiar nada, explica tu plan.';

/** The same for a WhatsApp conversation: its latest messages travel below, marked as data. */
export const orcaChatTask = 'Lee la conversación de WhatsApp del cliente que va debajo y resuelve en este repositorio lo que pide. Antes de cambiar nada, explica tu plan.';

/** The level a card carries, when it is not normal (the same words for mail and WhatsApp). */
export const levelNotes = { normal: null, local_only: 'Solo en este Mac: sin resumen de modelo', private: 'Privado: sin resumen de modelo' } as const;

/** What a card can have open: a form, or a conversation's latest messages. One card per action at a time. */
export type CardAction = 'filing' | 'noting' | 'scheduling' | 'replying' | 'orca' | 'issue' | 'messages';
