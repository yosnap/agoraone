import { sendClientLog } from './core';

type Send = typeof sendClientLog;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const REPEAT_MS = 30_000;

/** Where an error happened, without the address' fragment (it carries the access token) or its query values. */
function area(): string {
  try { return new URLSearchParams(window.location.search).get('seccion')?.slice(0, 40) || 'interfaz'; } catch { return 'interfaz'; }
}

/** Only the file name and line of the first frame: enough to find it, nothing about the user's data. */
export function place(file?: string, line?: number): string {
  if (!file) return '';
  const name = file.split(/[?#]/)[0].split('/').pop() ?? '';
  return name ? ` (${name}${line ? `:${line}` : ''})` : '';
}

/** Throttled sender: at most 20 entries a minute, the same text once every 30 s, and never about its own failures. */
export function makeReporter(send: Send = sendClientLog, now: () => number = Date.now) {
  let windowStart = 0, sent = 0;
  const last = new Map<string, number>();
  return (level: 'warning' | 'error', message: string) => {
    const at = now();
    if (at - windowStart > WINDOW_MS) { windowStart = at; sent = 0; }
    if (sent >= MAX_PER_WINDOW) return false;
    const text = message.slice(0, 2000);
    if (at - (last.get(text) ?? -Infinity) < REPEAT_MS) return false;
    last.set(text, at); sent += 1;
    void send({ level, area: area(), message: text }).catch(() => { /* the log is best effort; never loop on it */ });
    return true;
  };
}

let installed = false;

/** Sends the window's uncaught errors and rejected promises to AgoraOne's log (Ajustes › Registro). */
export function installClientLog() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const report = makeReporter();
  window.addEventListener('error', event => {
    const message = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : String(event.message || 'Error en la interfaz');
    report('error', message + place(event.filename, event.lineno));
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    report('error', reason instanceof Error ? `Promesa rechazada: ${reason.name}: ${reason.message}` : `Promesa rechazada: ${String(reason).slice(0, 300)}`);
  });
}
