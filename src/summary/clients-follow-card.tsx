import { useEffect, useState } from 'react';
import { getClients, type ClientsDirectory } from '../api/clients';
import { openClientsFilter } from '../jobs/jobs-tab';
import type { Section } from '../shell/shell-state';

/** A reminder to follow up the clients kept only in AgoraOne («sin ubicar») and the vault's client cards without a
 * client; each count leads to its filter in Trabajos › Clientes. Only numbers: no name, so also in discreet mode. */
export function ClientsFollowCard({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [data, setData] = useState<Pick<ClientsDirectory, 'unplacedCount' | 'vaultCards'> | null>(null);
  useEffect(() => {
    let alive = true;
    getClients(discreet).then(found => { if (alive) setData(found); }).catch(() => undefined);
    return () => { alive = false; };
  }, [discreet]);
  if (!data || (!data.unplacedCount && !data.vaultCards.count)) return null;
  const go = (filter: 'unplaced' | 'cards') => { openClientsFilter(filter); onOpen('jobs'); };
  return <article className="card" aria-labelledby="clients-follow-title">
    <div className="card-head"><h2 id="clients-follow-title">Clientes por ubicar</h2></div>
    <p className="muted">Clientes que solo están en AgoraOne y fichas «Clientes/…» de tu vault sin cliente: créalos o enlázalos donde toque.</p>
    <div className="field-row">
      {data.unplacedCount > 0 && <span>{data.unplacedCount} sin ubicar</span>}
      {data.vaultCards.count > 0 && <span>{data.vaultCards.count} {data.vaultCards.count === 1 ? 'ficha' : 'fichas'} sin cliente</span>}
      <span className="actions">
        {data.unplacedCount > 0 && <button type="button" className="button" onClick={() => go('unplaced')}>Ver sin ubicar</button>}
        {data.vaultCards.count > 0 && <button type="button" className="button" onClick={() => go('cards')}>Ver fichas</button>}
      </span>
    </div>
  </article>;
}
