import { useSyncExternalStore } from 'react';
import { getUpload, type UploadState } from '../api/core';

/** The phone upload, followed from anywhere in the app (1.5): while its window is open the screen shows
 * «Recibiendo…» as the file arrives and, once it is in, a notice that leads to it, whatever section is on
 * screen. The receipts panel listens too and shows the new receipt at once. */
type Watch = { state: UploadState | null; arrived: number | null };
let watch: Watch = { state: null, arrived: null };
const listeners = new Set<() => void>();
const set = (next: Partial<Watch>) => { watch = { ...watch, ...next }; listeners.forEach(listener => listener()); };
let timer = 0;
export const RECEIVED = 'agora:receipt-received';

export function followUpload(state?: UploadState) {
  if (state) set({ state });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    getUpload().then(next => {
      set({ state: next });
      if (next.open) { followUpload(); return; }
      if (next.received) { set({ arrived: next.received }); window.dispatchEvent(new CustomEvent(RECEIVED, { detail: next.received })); }
    }).catch(() => followUpload());
  }, 1500);
}
export const stopFollowing = () => { window.clearTimeout(timer); set({ state: null }); };
export const dismissArrival = () => set({ arrived: null });
export const useUpload = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => watch);

/** The notice of a receipt that arrived from the phone, over any section. */
export function UploadNotice({ onOpen }: { onOpen: () => void }) {
  const { state, arrived } = useUpload();
  if (state?.open && state.receiving) return <div className="alert-toasts" role="status" aria-live="polite">
    <div className="alert-toast"><div><strong>Recibiendo un archivo del móvil…</strong><p>En un momento aparece en Fiscal › Recibos.</p></div></div>
  </div>;
  if (!arrived) return null;
  return <div className="alert-toasts" role="status" aria-live="polite">
    <div className="alert-toast">
      <div><strong>Recibo recibido desde el móvil</strong><p>Míralo y completa sus datos para archivarlo.</p>
        <button type="button" className="button" onClick={() => { dismissArrival(); onOpen(); }}>Verlo</button></div>
      <button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={dismissArrival}>×</button>
    </div>
  </div>;
}
