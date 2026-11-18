import { fabricaDownload, fabricaExternalLink, openFabricaLink, type FabricaDownload, type FabricaLink } from '../api/fabrica';
import { eventStore, WindowLinkNotice } from '../shell/window-link-notice';

// What the fábrica's window tells AgoraOne's window, over any section: a link of its panel to another site (YouTube,
// Reddit…), never followed inside the window, and a file of a run that finished downloading to Downloads.
const links = eventStore<FabricaLink>('agora:fabrica-external', fabricaExternalLink);
const downloads = eventStore<FabricaDownload>('agora:fabrica-download', fabricaDownload);

/** «Esto se abre en tu navegador». In discreet mode the address is not shown. */
export function FabricaLinkNotice({ discreet }: { discreet: boolean }) {
  const found = links.use();
  if (!found) return null;
  return <WindowLinkNotice key={found.url} discreet={discreet} onClose={() => links.set(null)} title="Esto se abre en tu navegador"
    body={<p>La ventana de la fábrica solo carga páginas de su panel. Este enlace va a otro sitio{found.kind === 'http' ? ' y no va cifrado (http)' : ''}:</p>}
    url={found.url} action={found.kind === 'http' ? 'Abrir igualmente en el navegador' : 'Abrir en el navegador'}
    onAction={() => openFabricaLink(found.url)}/>;
}

/** «Descargado en Descargas: nombre» (the name hidden in discreet mode), or that it failed. */
export function FabricaDownloadNotice({ discreet }: { discreet: boolean }) {
  const found = downloads.use();
  if (!found) return null;
  return <div className="alert-toasts" role="status" aria-live="polite">
    <div className="alert-toast">
      <div><strong>{found.ok ? 'Descargado en Descargas' : 'No se pudo descargar'}</strong>
        <p>{discreet ? 'Nombre oculto en modo discreto.' : found.name}</p></div>
      <button type="button" className="icon-button" aria-label="Cerrar el aviso" onClick={() => downloads.set(null)}>×</button>
    </div>
  </div>;
}
