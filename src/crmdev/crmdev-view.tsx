import { useState } from 'react';
import { getConnector, type Connector } from '../api/core';
import { getCrmdevOrgs, setCrmdevOrg } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CrmdevClients } from './crmdev-clients';
import { CrmdevConnect, CrmdevProblem, OpenInCrmdev } from './crmdev-common';
import { CrmdevProjects } from './crmdev-projects';
import { CrmdevTasks } from './crmdev-tasks';
import { CrmdevTickets } from './crmdev-tickets';
import { clearChanges } from './use-crmdev-change';
import { CrmdevOrgPicker, pickOrg, rememberOrg, rememberedOrg } from './crmdev-org-picker';
import { useTabCounts, withCount } from '../shell/tab-counts';
import { CrmdevFromCentral } from '../sync/crmdev-from-central';
import { useModules, moduleOn } from '../shell/modules';
import { takeCrmdevTab, crmdevTabs, startCrmdev, useCrmdevRead, type CrmdevTabName } from './use-crmdev-view';
import '../central/central.css';
import './crmdev.css';

/** Whether the connector has what a read needs: an address and a key in the secret store. */
export const crmdevConnected = (connector: Connector | null) => Boolean(connector?.state.configured.url && connector.state.configured.hasKey);

/** The tabs and the open one; split from the section so it renders without reading the connection. */
export function CrmdevTabs({ tab, onTab, discreet, onOpen, org = null }: { tab: CrmdevTabName; onTab: (tab: CrmdevTabName) => void; discreet: boolean;
  onOpen: (section: Section) => void; org?: string | null }) {
  const { counts: all, reload } = useTabCounts();
  const counts = all && { crmdev: (org ? all.crmdevOrgs?.[org] : undefined) ?? all.crmdev };
  const modules = useModules();
  const tabs = crmdevTabs.filter(t => t.id !== 'central' || moduleOn(modules, 'central'));
  return <>
    <div className="segmented central-tabs" role="group" aria-label="Pestañas de CRMDev">
      {tabs.map(t => <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => onTab(t.id)}>
        {withCount(t.label, counts?.crmdev?.[t.id], t.id !== 'central' && counts?.crmdev?.[`${t.id}More`])}</button>)}
    </div>
    <div className="central-panel" key={org ?? ''}>
      {tab === 'proyectos' ? <CrmdevProjects discreet={discreet} onOpen={onOpen}/>
        : tab === 'tareas' ? <CrmdevTasks discreet={discreet} onOpen={onOpen}/>
        : tab === 'tickets' ? <CrmdevTickets discreet={discreet} onOpen={onOpen}/>
        : tab === 'central' ? <CrmdevFromCentral discreet={discreet} onChanged={reload} org={org ?? undefined}/>
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
  useState(() => { startCrmdev(); clearChanges(); });
  const [tab, setTab] = useState<CrmdevTabName>(takeCrmdevTab);
  const connection = useCrmdevRead('conexion', () => getConnector('crmdev'));
  const connected = crmdevConnected(connection.data);
  const orgs = useCrmdevRead(connected ? 'orgs' : null, () => getCrmdevOrgs());
  const [chosen, setChosen] = useState(rememberedOrg);
  const org = pickOrg(orgs.data?.orgs ?? [], chosen);
  setCrmdevOrg(org?.id ?? null);  // every read and change of the section goes to it (idempotent: only a value)
  // Another organization: what was read and the open changes are of the other one, so they are forgotten.
  const choose = (id: string) => { rememberOrg(id); setCrmdevOrg(id); startCrmdev(['conexion', 'orgs']); clearChanges(); setChosen(id); };
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
      : !orgs.data && !orgs.failure ? <Loading label="Leyendo las organizaciones de CRMDev" lines={2}/>
      : <>
        <CrmdevOrgPicker orgs={orgs.data?.orgs ?? []} org={org} onChange={choose}/>
        <CrmdevTabs tab={tab} onTab={setTab} discreet={discreet} onOpen={onOpen} org={org?.id ?? null}/>
      </>}
  </section>;
}
