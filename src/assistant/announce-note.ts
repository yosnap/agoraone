import type { Announcement } from '../api/core';
import { chatName } from '../inbox/inbox-cards';

const results = { done: 'marcado como hecho en la Bandeja', dismissed: 'descartado en la Bandeja', later: 'lo dejo en la Bandeja' } as const;

/** The note left after answering an announcement. In discreet mode it names nothing («Un WhatsApp», «Un correo»), and
 * a private conversation is never named, not even as «Conversación privada». */
export function announceNote(item: Announcement, state: 'done' | 'dismissed' | null, discreet: boolean) {
  const what = item.channel === 'chat'
    ? discreet ? 'Un WhatsApp' : item.confidentiality === 'private' || !item.participant ? 'Un WhatsApp privado' : `El WhatsApp de ${chatName(item)}`
    : discreet ? 'Un correo' : `«${item.subject || 'sin asunto'}»`;
  return `${what}: ${results[state ?? 'later']}.`;
}
