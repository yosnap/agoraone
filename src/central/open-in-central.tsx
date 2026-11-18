import { useState, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { centralExternalLink, openCentralInBrowser, openCentralLink, openCentralWindow, type CentralLink, type CentralPage } from '../api/central';
import './central.css';

/** Central's own web in a window of AgoraOne (1.7), never in a frame: for what has no native view here and for
 * «Abrir en Central» on a client, project or quote. The user signs in there with Central's own login. Without the
 * desktop app (AgoraOne in a browser tab) the same page can open in the system's browser. In discreet mode nothing
 * of Central is opened: its window would show what discreet mode hides. */
type Said = { ok: boolean; text: string; browser?: boolean };

const message = (error: unknown, fallback: string) => error instanceof ApiError || error instanceof Error ? error.message : fallback;

export function OpenInCentral({ page, label = 'Abrir en Central', discreet = false, browserToo = false }: {
  page: CentralPage; label?: string; discreet?: boolean; browserToo?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  if (discreet) return null;
  const open = async (inBrowser: boolean) => {
    setBusy(true); setSaid(null);
    try {
      if (inBrowser) {
        await openCentralInBrowser(page);
        setSaid({ ok: true, text: 'Abierto en tu navegador.' });
      } else {
        await openCentralWindow(page);
        setSaid({ ok: true, text: 'Abierto en la ventana de Central. La primera vez, inicia sesión con tu usuario de Central: se recuerda.' });
      }
    } catch (error) {
      const noWindow = error instanceof ApiError && error.data?.status === 'no_window';
      setSaid({ ok: false, text: message(error, 'No se pudo abrir Central.'), browser: noWindow });
    } finally { setBusy(false); }
  };
  return <div className="central-open">
    <div className="actions central-actions">
      <button type="button" className="button" disabled={busy} onClick={() => void open(false)}>{busy ? 'Abriendo…' : label}</button>
      {(browserToo || said?.browser) && <button type="button" className="button" disabled={busy} onClick={() => void open(true)}>Abrir en el navegador</button>}
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </div>;
}

const PAGES: { page: CentralPage; label: string; what: string; browserToo?: boolean }[] = [
  { page: 'ajustes', label: 'Ajustes de Central', browserToo: true,
    what: 'escáner, vídeos, integraciones y claves de apps. Conectar Google se hace en tu navegador (con tu sesión de Central allí): en la ventana no vuelve' },
  { page: 'correo', label: 'Correo de Central', what: 'el correo que Central lee de tus cuentas' },
  { page: '', label: 'Central completa', what: 'todo lo demás; los secretos de cada proyecto, desde su ficha' },
];

/** The parts of Central without a native view here, each one in Central's window. */
export function CentralPages({ discreet }: { discreet: boolean }) {
  return <section className="card central-pages" aria-labelledby="central-pages-title">
    <h2 id="central-pages-title">En la ventana de Central</h2>
    <p className="muted">Lo que AgoraOne no muestra aquí se abre con la web de Central en una ventana propia, con tu usuario de Central.</p>
    {discreet ? <p className="muted">En modo discreto no se abre Central.</p>
      : <ul className="central-pages-list">{PAGES.map(p => <li key={p.label}>
        <div><strong>{p.label}</strong><small className="muted">{p.what}</small></div>
        <OpenInCentral page={p.page} label="Abrir en ventana" browserToo={p.browserToo}/>
      </li>)}</ul>}
  </section>;
}

// A link of Central to another site is never followed inside its window: the desktop app tells this window, which
// offers to open it in the system's browser (http only after warning it is not encrypted). A sign-in with another
// service (Google…) is not offered: its return would reach a browser without Central's session, so Central's settings
// open in the browser instead.
let link: CentralLink | null = null;
const listeners = new Set<() => void>();
const setLink = (next: CentralLink | null) => { link = next; listeners.forEach(listener => listener()); };
const useLink = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => link);

if (typeof window !== 'undefined') window.addEventListener('agora:central-external', event => {
  const found = centralExternalLink((event as CustomEvent<unknown>).detail);
  if (found) setLink(found);
});

/** «Esto se abre en tu navegador», over any section. In discreet mode the address is not shown. */
export function CentralLinkNotice({ discreet }: { discreet: boolean }) {
  const found = useLink();
  const [failure, setFailure] = useState('');
  if (!found) return null;
  const close = () => { setFailure(''); setLink(null); };
  const open = async () => {
    try {
      if (found.kind === 'oauth') await openCentralInBrowser('ajustes'); else await openCentralLink(found.url);
      close();
    } catch (error) { setFailure(message(error, 'No se pudo abrir el navegador.')); }
  };
  const oauth = found.kind === 'oauth';
  return <div className="alert-toasts" role="status" aria-live="polite">
    <div className="alert-toast">
      <div><strong>{oauth ? 'Conectar una cuenta se hace en tu navegador' : 'Esto se abre en tu navegador'}</strong>
        {oauth ? <p>Dentro de la ventana de Central no funciona: la vuelta llega al navegador, que necesita tu sesión de Central. Abre los Ajustes de
          Central en tu navegador, inicia sesión allí y conecta la cuenta desde ahí.</p>
          : <p>La ventana de Central solo carga páginas de Central. Este enlace va a otro sitio{found.kind === 'http' ? ' y no va cifrado (http)' : ''}:</p>}
        {!oauth && (discreet ? <p className="muted">Dirección oculta en modo discreto.</p> : <p className="central-url">{found.url}</p>)}
        {failure && <p className="error">{failure}</p>}
        <div className="actions central-actions"><button type="button" className="button" onClick={() => void open()}>
          {oauth ? 'Abrir Ajustes de Central en el navegador' : found.kind === 'http' ? 'Abrir igualmente en el navegador' : 'Abrir en el navegador'}</button></div></div>
      <button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={close}>×</button>
    </div>
  </div>;
}
