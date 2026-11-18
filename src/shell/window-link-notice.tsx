import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import './window-link-notice.css';

// What an add-on's window (Central, Mi fábrica) tells AgoraOne's window: a link to another site it did not follow, or
// a download that ended. The desktop app sends it as an event with a JSON detail; each window keeps the latest one
// here until the user closes the notice.

export type EventStore<T> = { use: () => T | null; set: (next: T | null) => void };

/** The latest detail of `event` that `parse` accepts (anything else is ignored), shared by the whole screen. */
export function eventStore<T>(event: string, parse: (detail: unknown) => T | null): EventStore<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const set = (next: T | null) => { value = next; listeners.forEach(listener => listener()); };
  if (typeof window !== 'undefined') window.addEventListener(event, found => {
    const parsed = parse((found as CustomEvent<unknown>).detail);
    if (parsed) set(parsed);
  });
  const use = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => value);
  return { use, set };
}

export const failureText = (error: unknown, fallback: string) => error instanceof ApiError || error instanceof Error ? error.message : fallback;

/** «Esto se abre en tu navegador», over any section: what the link is, its address (hidden in discreet mode) and one
 * button on the right that opens it. */
export function WindowLinkNotice({ title, body, url, discreet, action, onAction, onClose }: {
  title: string; body: ReactNode; url?: string; discreet: boolean; action: string;
  /** Opens the link; a failure is shown in the notice, which then stays. */
  onAction: () => Promise<unknown>; onClose: () => void;
}) {
  const [failure, setFailure] = useState('');
  const close = () => { setFailure(''); onClose(); };
  const act = async () => {
    try { await onAction(); close(); } catch (error) { setFailure(failureText(error, 'No se pudo abrir el navegador.')); }
  };
  return <div className="alert-toasts" role="status" aria-live="polite">
    <div className="alert-toast">
      <div><strong>{title}</strong>
        {body}
        {url !== undefined && (discreet ? <p className="muted">Dirección oculta en modo discreto.</p> : <p className="window-link-url">{url}</p>)}
        {failure && <p className="error">{failure}</p>}
        <div className="actions window-link-actions"><button type="button" className="button" onClick={() => void act()}>{action}</button></div></div>
      <button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={close}>×</button>
    </div>
  </div>;
}
