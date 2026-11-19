import { useState } from 'react';
import { getCentralConnection, type CentralViewName } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralAgenda } from './central-agenda';
import { CentralAlerts, CentralPending } from './central-alerts';
import { CentralClients } from './central-clients';
import { CentralConnect, CentralProblem } from './central-connect';
import { CentralProjects } from './central-projects';
import { CentralServers } from './central-servers';
import { CentralSummary } from './central-summary';
import { CentralWebsites } from './central-websites';
import { CentralPages, OpenInCentral } from './open-in-central';
import { CONNECTION, centralTabs, forgetCentral, startCentral, useCentralRead, useCentralRereading } from './use-central-view';
import './central.css';
import { ActionButton } from '../ui/action-button';

/** The «Central» section: Central's summary, alerts, pending projects, clients, projects, websites, servers and its
 * agenda (not AgoraOne's own), read live from its
 * API through the core. With a key that may write, records change from their own view after seeing the exact change;
 * the rest opens in Central's window. Only the open tab is read. Without a connection by address and key it
 * says how to connect, and where the user's own clients are meanwhile. */
export function CentralView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  useState(startCentral);  // once per visit: nothing read before (or before connecting) is shown as current
  const [tab, setTab] = useState<CentralViewName>('resumen');
  const connection = useCentralRead(CONNECTION, getCentralConnection);
  const connected = connection.data?.transport === 'http';
  const rereading = useCentralRereading();
  return <section className="page central" aria-labelledby="central-title">
    <div className="eyebrow">CENTRAL{discreet ? ' · MODO DISCRETO' : ''}</div>
    <div className="central-head">
      <h1 id="central-title">Central</h1>
      {connected && <div className="actions central-actions"><ActionButton icon="refresh" label="Volver a leer" busyLabel={rereading && 'Leyendo…'} disabled={rereading} onClick={forgetCentral}/></div>}
    </div>
    <p className="page-lead">Lo que tienes en Central, leído ahora mismo de su API. Con una clave con permiso «escritura», los datos de un cliente, sus notas y el estado y la fase de un proyecto se cambian desde su ficha, viendo antes el cambio exacto; lo demás, con «Abrir en Central».</p>
    {connection.failure ? <CentralProblem failure={connection.failure} onRetry={connection.reload} onOpen={onOpen}/>
      : !connection.data ? <Loading label="Comprobando la conexión con Central" lines={2}/>
      : !connected ? <CentralConnect onOpen={onOpen}/>
      : <>
        <div className="segmented central-tabs" role="group" aria-label="Pestañas de Central">
          {centralTabs.map(t => <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div className="central-panel">
          {tab === 'resumen' ? <CentralSummary onTab={setTab} onOpen={onOpen}/>
            : tab === 'alertas' ? <CentralAlerts discreet={discreet} onOpen={onOpen}/>
            : tab === 'pendientes' ? <CentralPending discreet={discreet} onOpen={onOpen}/>
            : tab === 'clientes' ? <CentralClients discreet={discreet} onOpen={onOpen}/>
            : tab === 'proyectos' ? <CentralProjects discreet={discreet} onOpen={onOpen}/>
            : tab === 'webs' ? <CentralWebsites discreet={discreet} onOpen={onOpen}/>
            : tab === 'servidores' ? <CentralServers discreet={discreet} onOpen={onOpen}/>
            : <CentralAgenda discreet={discreet} onOpen={onOpen}/>}
          {(tab === 'webs' || tab === 'servidores' || tab === 'alertas') && <OpenInCentral page={tab} discreet={discreet}/>}
        </div>
        <CentralPages discreet={discreet}/>
      </>}
  </section>;
}
