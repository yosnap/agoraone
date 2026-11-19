import type { ReactNode } from 'react';
import { centralExternalLink, openCentralInBrowser, openCentralLink, type CentralLink, type CentralPage } from '../api/central';
import { OpenInConnector } from '../connectors/open-in-connector';
import { eventStore, WindowLinkNotice } from '../shell/window-link-notice';
import './central.css';

/** Central's own web in a window of AgoraOne (1.7), never in a frame: for what has no native view here and for
 * «Abrir en Central» on a client, project or quote. It is the connector window's button with Central's pages. */
export function OpenInCentral({ page, label = 'Abrir en Central', ...rest }: {
  page: CentralPage; label?: string; discreet?: boolean; browserToo?: boolean;
  /** What the button shows instead of `label` (a level badge that leads to the record), with `label` as its name. */
  content?: ReactNode; buttonClass?: string;
}) {
  return <OpenInConnector connector="central" page={page} label={label} {...rest}/>;
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
const links = eventStore<CentralLink>('agora:central-external', centralExternalLink);

/** What the notice of a link of Central says and does: a sign-in with another service opens Central's settings in the
 * browser instead, and its address is not shown. */
export function centralNotice(found: CentralLink) {
  const oauth = found.kind === 'oauth';
  return {
    title: oauth ? 'Conectar una cuenta se hace en tu navegador' : 'Esto se abre en tu navegador',
    body: oauth ? <p>Dentro de la ventana de Central no funciona: la vuelta llega al navegador, que necesita tu sesión de Central. Abre los Ajustes de
      Central en tu navegador, inicia sesión allí y conecta la cuenta desde ahí.</p>
      : <p>La ventana de Central solo carga páginas de Central. Este enlace va a otro sitio{found.kind === 'http' ? ' y no va cifrado (http)' : ''}:</p>,
    url: oauth ? undefined : found.url,
    action: oauth ? 'Abrir Ajustes de Central en el navegador' : found.kind === 'http' ? 'Abrir igualmente en el navegador' : 'Abrir en el navegador',
    onAction: () => oauth ? openCentralInBrowser('ajustes') : openCentralLink(found.url),
  };
}

/** «Esto se abre en tu navegador», over any section. In discreet mode the address is not shown. */
export function CentralLinkNotice({ discreet }: { discreet: boolean }) {
  const found = links.use();
  if (!found) return null;
  return <WindowLinkNotice key={found.url} discreet={discreet} onClose={() => links.set(null)} {...centralNotice(found)}/>;
}
