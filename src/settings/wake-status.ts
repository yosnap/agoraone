import type { WakeState } from '../api/core';

const PRIVACY = 'Ajustes del Sistema › Privacidad y seguridad';

/** What to tell the user about «Oye Watson» while it is turned on: whether it is listening, or why not and what to
 * do. `retry` offers trying again (after fixing a permission or installing Spanish dictation). */
export function wakeStatus(state: WakeState | null): { ok: boolean; text: string; retry: boolean } {
  switch (state) {
    case 'listening': return { ok: true, text: 'Escuchando: di «Oye Watson».', retry: false };
    case 'starting': case 'off': return { ok: true, text: 'Arrancando… Si macOS te pide permisos, acéptalos.', retry: false };
    case 'no_speech_permission': return { ok: false, text: `macOS no deja a AgoraOne usar el reconocimiento de voz. Actívalo en ${PRIVACY} › Reconocimiento de voz y pulsa «Reintentar».`, retry: true };
    case 'no_mic_permission': return { ok: false, text: `macOS no deja a AgoraOne usar el micrófono. Actívalo en ${PRIVACY} › Micrófono y pulsa «Reintentar».`, retry: true };
    case 'no_offline': return { ok: false, text: 'Este Mac no reconoce el español sin internet, y «Oye Watson» nunca envía el audio fuera. Activa el Dictado en español en Ajustes del Sistema › Teclado › Dictado para que lo descargue y pulsa «Reintentar».', retry: true };
    case 'mic_failed': return { ok: false, text: 'No se pudo abrir el micrófono. Mira que haya uno conectado y que otra app no lo tenga ocupado, y pulsa «Reintentar».', retry: true };
    case 'missing': return { ok: false, text: 'Falta el oyente de «Oye Watson» dentro de la app. Vuelve a instalar AgoraOne.', retry: false };
    case 'stopped': return { ok: false, text: 'El oyente de «Oye Watson» se ha parado. Pulsa «Reintentar».', retry: true };
    default: return { ok: false, text: 'La app de escritorio no ha dado señal: «Oye Watson» solo funciona en AgoraOne para Mac, no en el navegador.', retry: false };
  }
}
