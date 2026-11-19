import { request } from './client';

// A connector's own web (Central, CRMDev), in a window of the desktop app (/api/core/{label}/window*): only pages of a
// closed list of the connector's saved address. The user signs in there with the connector's own login; AgoraOne's key
// for its API never goes to that window. Each connector names its pages; these calls are the same for all.
export type WindowLabel = 'central' | 'crmdev';
const core = <T>(path: string, body: unknown) => request<T>(`/core${path}`, body);

/** Opens the page in the connector's window; 409 `no_window` when AgoraOne runs in a browser tab (no desktop app). */
export const openConnectorWindow = (label: WindowLabel, ruta: string) => core<{ seq: number }>(`/${label}/window`, { ruta });
/** The same page in the system's browser. */
export const openConnectorInBrowser = (label: WindowLabel, ruta: string) => core<{ done: true }>(`/${label}/window/browser`, { ruta });
/** A link of the connector's web to another site (http or https; the screen warns first about http), in the system's browser. */
export const openConnectorLink = (label: WindowLabel, url: string) => core<{ done: true }>(`/${label}/window/external`, { url });
/** A window label as the core's manifests give it (`Connector.window`): letters, digits and dashes, nothing else. */
const LABEL = /^[a-z0-9-]{1,40}$/;
const labelled = (label: string, action: 'close' | 'check') =>
  LABEL.test(label) ? core<{ done: boolean }>(`/${label}/window/${action}`, {}) : Promise.reject(new Error('Ventana desconocida.'));
/** Closes the connector's window (discreet mode turned on); nothing happens without the desktop app. */
export const closeConnectorWindow = (label: string) => labelled(label, 'close');
/** Makes the desktop app look again at once whether the window may stay (module and address changed): any connector
 * with a window of its own (Central, CRMDev, Mi fábrica…) answers at `/{label}/window/check`. */
export const checkConnectorWindow = (label: string) => labelled(label, 'check');

/** A link of a connector's web to another site, as the desktop app hands it over: `oauth` when it is a sign-in with
 * another service (it would come back to a browser without the connector's session), `http` when it is not encrypted. */
export type WindowLink = { url: string; kind: 'oauth' | 'http' | 'https' };
const OAUTH_HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com']);
/** The link of the event the desktop app sends: only web addresses, of bounded size. */
export const windowExternalLink = (detail: unknown): WindowLink | null => {
  const url = (detail as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length > 2000) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const oauth = OAUTH_HOSTS.has(parsed.hostname) || /\/oauth2?(\/|$)/i.test(parsed.pathname)
    || (parsed.searchParams.has('client_id') && parsed.searchParams.has('redirect_uri'));
  return { url, kind: oauth ? 'oauth' : parsed.protocol === 'http:' ? 'http' : 'https' };
};
