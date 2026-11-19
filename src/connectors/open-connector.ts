import type { Section } from '../shell/shell-state';

// Conectores is the only place where an external module is connected. Any screen that needs a connection (Central's
// section, Presupuestos, the clients) leads there with ?conector=<id>, which scrolls to that card and focuses it.
const PARAM = 'conector';

/** The connector a link names, when its id looks like one (letters, digits and dashes). */
export function connectorFromLink(search: string): string | null {
  const id = new URLSearchParams(search).get(PARAM);
  return id && /^[a-z0-9-]{1,40}$/.test(id) ? id : null;
}

/** Opens Conectores on the card of `id`. The old Ajustes tab and section named in the link are dropped, so a reload
 * stays in Conectores. */
export function openConnector(id: string, onOpen: (section: Section) => void) {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.delete('pestana');
    url.searchParams.delete('seccion');
    url.searchParams.set(PARAM, id);
    window.history.replaceState(window.history.state, '', url);
  }
  onOpen('connectors');
}

/** Reads the connector named in the link once and removes it, so it does not take over a later reload. */
export function takeConnectorLink(): string | null {
  if (typeof window === 'undefined') return null;
  const id = connectorFromLink(window.location.search);
  if (window.location.search.includes(`${PARAM}=`)) {
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM);
    window.history.replaceState(window.history.state, '', url);
  }
  return id;
}
