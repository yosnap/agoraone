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
