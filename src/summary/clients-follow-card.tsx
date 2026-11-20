import { useEffect, useState } from 'react';
import { getClientBirths, getClients, type ClientsDirectory } from '../api/clients';
import { openClientsFilter } from '../jobs/jobs-tab';
import { openCentralTab } from '../central/use-central-view';
import type { Section } from '../shell/shell-state';

/** A reminder to follow up the clients kept only in AgoraOne («sin ubicar») and the vault's client cards without a
 * client; each count leads to its filter in Trabajos › Clientes. Only numbers: no name, so also in discreet mode. */
export function ClientsFollowCard({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [data, setData] = useState<Pick<ClientsDirectory, 'unplacedCount' | 'vaultCards' | 'central'> | null>(null);
  const [proposals, setProposals] = useState(0);
  useEffect(() => {
    let alive = true;
    getClients(discreet).then(found => {
      if (!alive) return;
      setData(found);
      if (found.central.on && found.central.read) getClientBirths().then(b => { if (alive) setProposals(b.items.length); }).catch(() => undefined);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [discreet]);
  if (!data || (!data.unplacedCount && !data.vaultCards.count && !proposals)) return null;
  const go = (filter: 'unplaced' | 'cards') => { openClientsFilter(filter); onOpen('jobs'); };
  const toCreate = () => { openCentralTab('por-crear'); onOpen('central'); };
  return <article className="card" aria-labelledby="clients-follow-title">
    <div className="card-head"><h2 id="clients-follow-title">Clientes por ubicar</h2></div>
    <p className="muted">Clientes que solo están en AgoraOne, fichas «Clientes/…» de tu vault sin cliente y quien te escribe o se reúne contigo sin ser cliente: créalos en Central o enlázalos.</p>
    <div className="field-row">
      {data.unplacedCount > 0 && <span>{data.unplacedCount} sin ubicar</span>}
      {data.vaultCards.count > 0 && <span>{data.vaultCards.count} {data.vaultCards.count === 1 ? 'ficha' : 'fichas'} sin cliente</span>}
      {proposals > 0 && <span>{proposals} {proposals === 1 ? 'propuesta' : 'propuestas'} para Central</span>}
      <span className="actions">
        {data.unplacedCount > 0 && <button type="button" className="button" onClick={() => go('unplaced')}>Ver sin ubicar</button>}
        {data.vaultCards.count > 0 && <button type="button" className="button" onClick={() => go('cards')}>Ver fichas</button>}
        {proposals > 0 && <button type="button" className="button" onClick={toCreate}>Crear en Central</button>}
      </span>
    </div>
  </article>;
}
