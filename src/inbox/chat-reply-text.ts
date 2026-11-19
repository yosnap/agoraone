import type { ChatWindow } from '../api/core';

/** Meta's charge for replies, as its pricing page states it (checked 19/11/2026); shown in the preview and in Settings. */
export const META_COST_NOTICE = 'Responder desde AgoraOne envía un mensaje de servicio de WhatsApp. Desde el 1 de octubre de 2026, Meta da '
  + '1.000 mensajes de servicio gratis al mes por número y cobra a partir del 1.001; si tu cuenta de Meta no tiene método de pago, '
  + 'los que pasen de esos 1.000 no se entregan. Consulta tu cuenta de Meta.';
/** The user's decision (19/11/2026): replying may mark the contact's earlier messages as read, as on the phone. */
export const READ_NOTICE = 'Al responder, WhatsApp puede marcar como leídos sus mensajes anteriores, como al contestar desde el móvil.';
export const CLOSED_REASON = 'Han pasado más de 24 h desde su último mensaje: WhatsApp solo deja responder con plantillas aprobadas, que AgoraOne no envía.';
const NEVER_REASON = 'No hay ningún mensaje suyo guardado: WhatsApp solo deja responder en las 24 h siguientes a su último mensaje.';
const CLOSING_REASON = 'A su ventana de 24 h le queda menos de un minuto: ya no da tiempo a enviar con seguridad.';

const day = (moment: Date, timeZone?: string) => moment.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', timeZone });
const hour = (moment: Date, timeZone?: string) => moment.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone });

/** «Abierta hasta las 14:32» (or «hasta el 20/11 a las 14:32» on another day), «Cerrada desde el 19/11 a las 14:32». */
export function windowText(window: ChatWindow, now = new Date(), timeZone?: string): string {
  if (!window.until) return 'Cerrada: no hay ningún mensaje suyo guardado';
  const until = new Date(window.until);
  const at = day(until, timeZone) === day(now, timeZone) ? `las ${hour(until, timeZone)}` : `el ${day(until, timeZone)} a las ${hour(until, timeZone)}`;
  if (window.open) return `Abierta hasta ${at}`;
  return until > now ? `Cerrándose: termina a ${at}` : `Cerrada desde ${at}`;
}

/** Why a reply cannot leave now, or null when the window is open. */
export function closedReason(window: ChatWindow, now = new Date()): string | null {
  if (window.open) return null;
  if (!window.until) return NEVER_REASON;
  return new Date(window.until) > now ? CLOSING_REASON : CLOSED_REASON;
}

/** «12 / 4096», and whether the text is over WhatsApp's limit. */
export function counter(text: string, max: number): { label: string; over: boolean } {
  const used = [...text.trim()].length;
  return { label: `${used} / ${max}`, over: used > max };
}
