import { request } from './client';

// Mi fábrica's own panel, in a window of the desktop app (/api/core/fabrica/window*): only pages of a closed list of
// `http://127.0.0.1:{port}`, with the port of its folder registered in Conectores. The user signs in there with the
// panel's own password; nothing of the panel goes through AgoraOne's API.
const core = <T>(path: string, body?: unknown, method?: string) => request<T>(`/core${path}`, body, method);

export type FabricaPage = '' | 'corridas' | 'publicaciones' | 'competidores' | 'piezas' | 'ideas' | 'senales' | 'ajustes';
/** Opens the page in the fábrica's window; 409 `no_window` when AgoraOne runs in a browser tab (no desktop app). */
export const openFabricaWindow = (ruta: FabricaPage) => core<{ seq: number }>('/fabrica/window', { ruta });
/** The same page in the system's browser. */
export const openFabricaInBrowser = (ruta: FabricaPage) => core<{ done: true }>('/fabrica/window/browser', { ruta });
/** A link of the panel to another site (http or https), in the system's browser. */
export const openFabricaLink = (url: string) => core<{ done: true }>('/fabrica/window/external', { url });
/** Closes the fábrica's window (discreet mode turned on); nothing happens without the desktop app. */
export const closeFabricaWindow = () => core<{ done: boolean }>('/fabrica/window/close', {});
/** Makes the desktop app look again at once whether the window may stay (module turned off, folder or port changed). */
export const checkFabricaWindow = () => core<{ done: boolean }>('/fabrica/window/check', {});
/** Asks macOS to start the fábrica's own service (`launchctl kickstart`, never stops or changes it); `running` when its
 * panel already answered. 409 `unsupported` outside macOS, `not_installed` without its service. */
export const startFabrica = () => core<{ done: true; running: boolean }>('/fabrica/start', {});

/** A link of the panel to another site, as the desktop app hands it over: only web addresses, of bounded size. */
export type FabricaLink = { url: string; kind: 'http' | 'https' };
export const fabricaExternalLink = (detail: unknown): FabricaLink | null => {
  const url = (detail as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length > 2000) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return { url, kind: parsed.protocol === 'http:' ? 'http' : 'https' };
};

/** A download of the fábrica's window that ended: the file's name (never its path) and whether it worked. */
export type FabricaDownload = { name: string; ok: boolean };
export const fabricaDownload = (detail: unknown): FabricaDownload | null => {
  const found = detail as { name?: unknown; ok?: unknown } | null;
  if (typeof found?.name !== 'string' || typeof found.ok !== 'boolean' || found.name.length > 300 || /[/\\]/.test(found.name)) return null;
  return { name: found.name, ok: found.ok };
};
