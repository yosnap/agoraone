import { useRef, useState } from 'react';
import { ackAlerts, getDueAlerts, type DueAlert } from '../api/core';

const EVERY = 60_000;

/** While AgoraOne is in front (macOS shows no banners for the app in front), the reminders due now appear
 * here and are confirmed as shown; otherwise the app shows them as macOS notifications. In discreet mode
 * they say only what kind of reminder it is. */
export function AlertToasts({ discreet }: { discreet: boolean }) {
  const [shown, setShown] = useState<DueAlert[]>([]);
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    const check = async () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        try {
          const due = (await getDueAlerts()).notifications;
          if (due.length) {
            setShown(current => [...current.filter(a => !due.some(d => d.key === a.key)), ...due].slice(-5));
            await ackAlerts(due.map(a => a.key));
          }
        } catch { /* the next minute tries again */ }
      }
      window.setTimeout(() => void check(), EVERY);
    };
    window.setTimeout(() => void check(), 5000);
  }
  if (!shown.length) return null;
  const kinds: Record<DueAlert['kind'], string> = { call: 'Llamada perdida', meeting: 'Reunión próxima', commitment: 'Plazo de un correo', summary: 'Tu día' };
  return <>
    {shown.map(alert => <div key={alert.key} className="alert-toast">
      <div><strong>{discreet ? kinds[alert.kind] : alert.title}</strong>{!discreet && alert.body && <p>{alert.body}</p>}</div>
      <button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={() => setShown(current => current.filter(a => a.key !== alert.key))}>×</button>
    </div>)}
  </>;
}
