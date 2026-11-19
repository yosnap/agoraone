import { linkClientPair, linkCrmdevClient, originLabels, type DirectoryClient } from '../api/clients';
import { OpenInCentral } from '../central/open-in-central';
import { OpenInCrmdev } from '../crmdev/crmdev-common';
import { clientStatusLabels, labelOf } from '../crmdev/crmdev-labels';
import { ClientPlacement } from './client-placement';
import { differenceText, staleText } from './clients-view';
import { ActionButton } from '../ui/action-button';

const originTone = { central: 'paused', crmdev: 'waiting', local: 'good' } as const;

/** Where a client comes from: Central, CRMDev, AgoraOne (one badge each). */
export function ClientOrigins({ client }: { client: DirectoryClient }) {
  return <span className="client-origins">{client.sources.map(origin =>
    <span key={origin} className={`status-badge dot ${originTone[origin]}`}>{originLabels[origin]}</span>)}
    {client.unplaced && <span className="status-badge bad">Sin ubicar</span>}
    {client.repeated && <span className="status-badge waiting">Nombre repetido</span>}</span>;
}

/** A client of the directory: its sources, CRMDev's state, what CRMDev has otherwise than Central (shown, never
 * synchronized), «Abrir en Central» and «Abrir en CRMDev» when it is linked there, and for one kept here the CRMs where
 * it can still be created. `act` runs a change and reads the directory again. No address, phone nor tax id here. */
export function ClientDetail({ client, can, discreet, busy, act, onClose, onDone }: {
  client: DirectoryClient; can: { central: boolean; crmdev: boolean }; discreet: boolean; busy: boolean;
  act: (work: () => Promise<unknown>, said: string) => void; onClose: () => void; onDone: (said: string) => void;
}) {
  const { localId, centralId, crmdevId } = client;
  const separable = client.aliases.length > 0 && crmdevId !== null;
  return <article className="card client-detail" aria-labelledby="client-detail-title">
    <div className="card-head"><h3 id="client-detail-title">{client.name}</h3>
      <span className="actions">
        {centralId && <OpenInCentral page={`clientes/${centralId}`} discreet={discreet}/>}
        {crmdevId && <OpenInCrmdev page={`clientes/${crmdevId}`} discreet={discreet}/>}
        <ActionButton icon="close" label="Cerrar" onClick={onClose}/>
      </span></div>
    <p><ClientOrigins client={client}/>
      {client.crmdevStatus && <small className="muted"> · En CRMDev: {labelOf(clientStatusLabels, client.crmdevStatus)}</small>}</p>
    {client.staleLink && <p className="notice">{staleText(client.staleLink)}</p>}
    {client.repeated && <p className="muted">Hay otro cliente con este mismo nombre: si son el mismo, enlázalos con la sugerencia; si no, cambia el nombre en su CRM.</p>}
    {client.company && client.company !== client.name && <p className="muted">Empresa: {client.company}</p>}
    {client.aliases.length > 0 && <p className="muted">También se llama «{client.aliases.join('», «')}».</p>}
    {client.differences.length > 0 && <ul className="client-differences" aria-label="Diferencias con CRMDev">
      {client.differences.map(difference => <li key={difference.field}>{differenceText(difference)}</li>)}
      <li className="muted">Central manda en los datos fiscales y de contacto; no se cambia ninguno de los dos.</li></ul>}
    {client.contacts.length > 0 && <div className="client-contacts">
      <strong>Personas de este cliente en CRMDev ({client.contacts.length})</strong>
      {discreet ? <p className="muted">Sus nombres no se ven en modo discreto.</p>
        : <ul className="install-list" aria-label="Personas en CRMDev">{client.contacts.map(contact => <li key={contact.id} className="install-row">
          <span>{contact.name}{contact.status && <small className="muted"> · {labelOf(clientStatusLabels, contact.status)}</small>}</span>
          <span className="actions">
            <OpenInCrmdev page={`clientes/${contact.id}`} discreet={discreet}/>
            {(centralId !== null || localId !== null) && <button type="button" className="button" disabled={busy}
              onClick={() => act(() => (centralId !== null ? linkClientPair(centralId, contact.id, 'distinct') : linkCrmdevClient(localId!, contact.id, 'distinct')),
                `«${contact.name}» ya no va con ${client.name}.`)}>No es de este cliente</button>}
          </span>
        </li>)}</ul>}
    </div>}
    {client.sources.includes('central') && <p className="muted">{client.projects.length} {client.projects.length === 1 ? 'proyecto' : 'proyectos'} en Central.</p>}
    {!discreet && separable && <div className="actions">
      {localId !== null && !client.sources.includes('central')
        ? <button type="button" className="button" disabled={busy}
          onClick={() => act(() => linkCrmdevClient(localId, crmdevId, 'distinct'), 'Tu cliente y el de CRMDev se quedan como clientes distintos.')}>No es el mismo que el de CRMDev</button>
        : centralId !== null && localId === null
          ? <button type="button" className="button" disabled={busy}
            onClick={() => act(() => linkClientPair(centralId, crmdevId, 'distinct'), 'El de Central y el de CRMDev se quedan como clientes distintos.')}>Son distintos en Central y CRMDev</button>
          : null}
    </div>}
    {!discreet && localId !== null && <ClientPlacement key={localId} client={{ ...client, localId }} can={can} onDone={onDone}/>}
  </article>;
}
