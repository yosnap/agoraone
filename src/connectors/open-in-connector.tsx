import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { openConnectorInBrowser, openConnectorLink, openConnectorWindow, windowExternalLink, type WindowLabel, type WindowLink } from '../api/connector-window';
import { eventStore, WindowLinkNotice } from '../shell/window-link-notice';
import { ActionButton } from '../ui/action-button';
import '../central/central.css';

/** A connector's own web in a window of AgoraOne (1.7), never in a frame: «Abrir en Central», «Abrir en CRMDev»… on a
 * record, and what has no native view here. The user signs in there with the connector's own login. Without the
 * desktop app (AgoraOne in a browser tab) the same page can open in the system's browser. In discreet mode nothing is
 * opened: the window would show what discreet mode hides. */
type Said = { ok: boolean; text: string; browser?: boolean };

export const windowNames: Record<WindowLabel, string> = { central: 'Central', crmdev: 'CRMDev' };

/** CRMDev treats its support pages as public, so when it asks to sign in there it does not come back to the page
 * afterwards but to its panel: the user is told to press the button again. */
export const pageNote = (connector: WindowLabel, page: string) => connector === 'crmdev' && (page === 'soporte' || page.startsWith('tickets/'))
  ? ' Si CRMDev te pide entrar, después puede llevarte a su panel: vuelve a pulsar el botón.' : '';

const message = (error: unknown, fallback: string) => error instanceof ApiError || error instanceof Error ? error.message : fallback;

/** What the button does, apart from the screen so it can be checked: opens the page in the window or the browser and
 * says what happened; `browser` when there is no desktop app and the browser is the way. */
export async function openPage(connector: WindowLabel, page: string, inBrowser: boolean,
  deps = { window: openConnectorWindow, browser: openConnectorInBrowser }): Promise<Said> {
  const name = windowNames[connector];
  try {
    if (inBrowser) {
      await deps.browser(connector, page);
      return { ok: true, text: 'Abierto en tu navegador.' };
    }
    await deps.window(connector, page);
    return { ok: true, text: `Abierto en la ventana de ${name}. La primera vez, inicia sesión con tu usuario de ${name}: se recuerda.${pageNote(connector, page)}` };
  } catch (error) {
    const noWindow = error instanceof ApiError && error.data?.status === 'no_window';
    return { ok: false, text: message(error, `No se pudo abrir ${name}.`), browser: noWindow };
  }
}

export function OpenInConnector({ connector, page, label, discreet = false, browserToo = false, content, buttonClass = 'button' }: {
  connector: WindowLabel; page: string; label?: string; discreet?: boolean; browserToo?: boolean;
  /** What the button shows instead of `label` (a level badge that leads to the record), with `label` as its name. */
  content?: ReactNode; buttonClass?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  if (discreet) return null;
  const name = label ?? `Abrir en ${windowNames[connector]}`;
  const open = async (inBrowser: boolean) => {
    setBusy(true); setSaid(null);
    setSaid(await openPage(connector, page, inBrowser));
    setBusy(false);
  };
  return <div className="central-open">
    <div className="actions central-actions">
      {content ? <button type="button" className={buttonClass} disabled={busy} aria-label={name} title={name}
        onClick={() => void open(false)}>{busy ? 'Abriendo…' : content}</button>
        : <ActionButton icon="external" label={name} busyLabel={busy && 'Abriendo…'} className={buttonClass === 'button' ? undefined : buttonClass}
          disabled={busy} onClick={() => void open(false)}/>}
      {(browserToo || said?.browser) && <ActionButton icon="external" label="Abrir en el navegador" disabled={busy} onClick={() => void open(true)}/>}
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </div>;
}

// A link of CRMDev's web to another site is never followed inside its window: the desktop app tells this window,
// which offers to open it in the system's browser (http only after warning it is not encrypted). Signing in with
// another service (GitHub…) is not offered: its return would reach a browser without CRMDev's session in the window.
const crmdevLinks = eventStore<WindowLink>('agora:crmdev-external', windowExternalLink);

/** What the notice of a link of CRMDev's window says and does. */
export function crmdevNotice(found: WindowLink, deps = { link: openConnectorLink, browser: openConnectorInBrowser }) {
  const oauth = found.kind === 'oauth';
  return {
    title: oauth ? 'Entrar con otra cuenta se hace en tu navegador' : 'Esto se abre en tu navegador',
    body: oauth ? <p>Dentro de la ventana de CRMDev no funciona: la vuelta llega al navegador. En la ventana, entra con el código por correo o con tu
      contraseña, o abre CRMDev en tu navegador.</p>
      : <p>La ventana de CRMDev solo carga páginas de CRMDev. Este enlace va a otro sitio{found.kind === 'http' ? ' y no va cifrado (http)' : ''}:</p>,
    url: oauth ? undefined : found.url,
    action: oauth ? 'Abrir CRMDev en el navegador' : found.kind === 'http' ? 'Abrir igualmente en el navegador' : 'Abrir en el navegador',
    onAction: () => oauth ? deps.browser('crmdev', 'panel') : deps.link('crmdev', found.url),
  };
}

// CRMDev's window never downloads (the user's decision, 19/11/2026): a download or an export (`blob:`, `data:`) is
// refused there and the desktop app says so, with the page the window was on when it is CRMDev's own.
export type RefusedDownload = { url: string | null };
export const refusedDownload = (detail: unknown): RefusedDownload | null => {
  if (typeof detail !== 'object' || detail === null) return null;
  const link = windowExternalLink(detail);
  return { url: link && link.kind !== 'oauth' ? link.url : null };
};
const crmdevDownloads = eventStore<RefusedDownload>('agora:crmdev-download-refused', refusedDownload);

/** What the notice of a refused download says and does: the same page in the browser, or CRMDev's panel. */
export function crmdevDownloadNotice(found: RefusedDownload, deps = { link: openConnectorLink, browser: openConnectorInBrowser }) {
  return {
    title: 'Las descargas de CRMDev se hacen en tu navegador',
    body: <p>La ventana de CRMDev no descarga archivos ni exportaciones. Abre la página en tu navegador, inicia sesión allí si hace falta y descárgalo
      desde ahí.</p>,
    url: found.url ?? undefined,
    action: 'Abrir en el navegador',
    onAction: () => found.url ? deps.link('crmdev', found.url) : deps.browser('crmdev', 'panel'),
  };
}

/** «Las descargas de CRMDev se hacen en tu navegador», over any section. In discreet mode the address is not shown. */
export function CrmdevDownloadNotice({ discreet }: { discreet: boolean }) {
  const found = crmdevDownloads.use();
  if (!found) return null;
  return <WindowLinkNotice key={found.url ?? 'panel'} discreet={discreet} onClose={() => crmdevDownloads.set(null)} {...crmdevDownloadNotice(found)}/>;
}

/** «Esto se abre en tu navegador» for CRMDev's window, over any section. In discreet mode the address is not shown. */
export function CrmdevLinkNotice({ discreet }: { discreet: boolean }) {
  const found = crmdevLinks.use();
  if (!found) return null;
  return <WindowLinkNotice key={found.url} discreet={discreet} onClose={() => crmdevLinks.set(null)} {...crmdevNotice(found)}/>;
}
