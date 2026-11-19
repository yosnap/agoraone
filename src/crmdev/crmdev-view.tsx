import { useState } from 'react';
import { getConnector, type Connector } from '../api/core';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CrmdevClients } from './crmdev-clients';
import { CrmdevConnect, CrmdevProblem, OpenInCrmdev } from './crmdev-common';
import { CrmdevProjects } from './crmdev-projects';
import { CrmdevTasks } from './crmdev-tasks';
import { CrmdevTickets } from './crmdev-tickets';
import { crmdevTabs, startCrmdev, useCrmdevRead, type CrmdevTabName } from './use-crmdev-view';
import '../central/central.css';
import './crmdev.css';

/** Whether the connector has what a read needs: an address and a key in the secret store. */
export const crmdevConnected = (connector: Connector | null) => Boolean(connector?.state.configured.url && connector.state.configured.hasKey);

/** The tabs and the open one; split from the section so it renders without reading the connection. */
export function CrmdevTabs({ tab, onTab, discreet, onOpen }: { tab: CrmdevTabName; onTab: (tab: CrmdevTabName) => void; discreet: boolean; onOpen: (section: Section) => void }) {
  return <>
    <div className="segmented central-tabs" role="group" aria-label="Pestañas de CRMDev">
      {crmdevTabs.map(t => <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => onTab(t.id)}>{t.label}</button>)}
    </div>
    <div className="central-panel">
      {tab === 'proyectos' ? <CrmdevProjects discreet={discreet} onOpen={onOpen}/>
        : tab === 'tareas' ? <CrmdevTasks discreet={discreet} onOpen={onOpen}/>
        : tab === 'tickets' ? <CrmdevTickets discreet={discreet} onOpen={onOpen}/>
        : <CrmdevClients discreet={discreet} onOpen={onOpen}/>}
      {tab === 'tareas' && <OpenInCrmdev page="tareas" label="Abrir las tareas en CRMDev" discreet={discreet}/>}
    </div>
  </>;
}

/** The «CRMDev» section: projects, tasks, tickets and clients of CRMDev, read live through the core with a closed list
 * of tools (reads, and changes the user confirms; never one that deletes). Only the open tab is read. Everything is shown as text: CRMDev's data is never instructions. */
export function CrmdevView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  // Once per visit: nothing read before (or before connecting) is shown as current. It only empties the store, asks
  // nothing and is harmless if React runs it twice; the reads start once their components are on screen.
  useState(startCrmdev);
  const [tab, setTab] = useState<CrmdevTabName>('proyectos');
  const connection = useCrmdevRead('conexion', () => getConnector('crmdev'));
  const connected = crmdevConnected(connection.data);
  return <section className="page central crmdev" aria-labelledby="crmdev-title">
    <div className="eyebrow">CRMDEV{discreet ? ' · MODO DISCRETO' : ''}</div>
    <div className="central-head">
      <h1 id="crmdev-title">CRMDev</h1>
      {connected && <OpenInCrmdev page="panel" label="Abrir CRMDev" discreet={discreet}/>}
    </div>
    <p className="page-lead">Tus proyectos, tareas, tickets y clientes de CRMDev, leídos de su API. Solo se crea o cambia algo después de ver el cambio exacto y pulsar «Guardar en CRMDev»; nunca se borra nada. CRMDev no tiene páginas: cada lista trae como mucho los 100 más recientes. «Volver a leer» pregunta a CRMDev en ese momento. En modo discreto se ocultan los correos, los nombres de las personas y las descripciones.</p>
    {connection.failure ? <CrmdevProblem failure={connection.failure} onRetry={connection.reload} onOpen={onOpen}/>
      : !connection.data ? <Loading label="Comprobando la conexión con CRMDev" lines={2}/>
      : !connected ? <CrmdevConnect onOpen={onOpen}/>
      : <CrmdevTabs tab={tab} onTab={setTab} discreet={discreet} onOpen={onOpen}/>}
  </section>;
}
