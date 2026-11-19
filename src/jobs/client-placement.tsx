import { useState } from 'react';
import { linkClient, linkCrmdevClient, type DirectoryClient } from '../api/clients';
import { refreshCentral } from '../api/core';
import { refreshCrmdevClients } from '../api/crmdev';
import { ChangeReview, useCentralChange } from '../central/central-change';
import { CrmdevReview, reviewing } from '../crmdev/crmdev-common';
import { clientStatusLabels } from '../crmdev/crmdev-labels';
import { optionsOf } from '../crmdev/crmdev-edit-ticket';
import { changeKey, resetChange, useCrmdevChange } from '../crmdev/use-crmdev-change';
import { ApiError } from '../api/client';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { placements } from './clients-view';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Reads CRMDev's clients again before linking with an existing one; CRMDev asking to wait (or another reading under
 * way) is waited out twice, a few seconds apart, before saying so. */
export async function refreshForLink(refresh: () => Promise<unknown> = refreshCrmdevClients, wait: (ms: number) => Promise<unknown> = pause) {
  for (let attempt = 0; ; attempt++) {
    try { await refresh(); return; }
    catch (error) {
      const busy = error instanceof ApiError && (error.status === 429 || error.data?.status === 'busy');
      if (!busy || attempt >= 2) throw busy ? new Error('CRMDev pide esperar unos segundos: vuelve a pulsar «Enlazar con el existente» en un momento.') : error;
      await wait(4000);
    }
  }
}

/** «Crear en Central» and «Crear en CRMDev» for a client kept in AgoraOne: the user picks the CRM (or both, one after
 * the other). Each shows the exact client that will be created, and only «Guardar en …» creates it; then the client
 * kept here is linked with the new one, so it shows once. When that CRM already has it, «Enlazar con el existente»
 * links them instead. Not offered in discreet mode (the review shows the address and phone). */
export function ClientPlacement({ client, can, onDone }: {
  client: DirectoryClient & { localId: number }; can: { central: boolean; crmdev: boolean }; onDone: (said: string) => void;
}) {
  const [where, setWhere] = useState<'central' | 'crmdev' | null>(null);
  const [status, setStatus] = useState('CUSTOMER');
  const [error, setError] = useState('');
  const id = client.localId;
  const central = useCentralChange(said => {
    void refreshCentral().catch(() => undefined).finally(() => { setWhere(null); onDone(said); });
  });
  const crmdevKey = changeKey('cliente-desde-local', String(id));
  const crmdev = useCrmdevChange(crmdevKey, said => { setWhere(null); onDone(said); });
  const options = placements(client, can);
  const close = () => { central.reset(); resetChange(crmdevKey); setWhere(null); };
  const link = async (work: () => Promise<unknown>, said: string) => {
    setError('');
    try { await work(); close(); onDone(said); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo enlazar.'); }
  };
  if (!options.length && !client.unplaced) return null;
  return <div className="client-placement">
    {client.unplaced && <p className="notice">Sin ubicar: créalo en Central o en CRMDev{options.length ? '' : ' (conecta uno de los dos en Conectores)'}.</p>}
    {where === null && options.length > 0 && <div className="field-row">
      {options.includes('crmdev') && <label className="field">Estado en CRMDev<ModernSelect value={status} onChange={setStatus}
        options={optionsOf(clientStatusLabels, null)}/></label>}
      <span className="actions">
        {options.includes('central') && <button type="button" className="button" onClick={() => { setWhere('central'); void central.ask({ kind: 'cliente-nuevo', localId: id }); }}>Crear en Central…</button>}
        {options.includes('crmdev') && <button type="button" className="button" onClick={() => { setWhere('crmdev'); void crmdev.ask({ kind: 'cliente-desde-local', localId: id, status }); }}>Crear en CRMDev…</button>}
      </span>
    </div>}
    {where === 'central' && (central.busy && !central.preview ? <Loading label="Preparando el cliente para Central" lines={2}/>
      : <ChangeReview change={central} onCancel={close} onReview={close}
        onLink={centralId => void link(async () => { await refreshCentral(); await linkClient(id, centralId); },
          `Enlazado con «${central.exists?.centralName ?? 'el cliente'}» de Central.`)}/>)}
    {where === 'crmdev' && (crmdev.busy && !reviewing(crmdev) ? <Loading label="Preparando el cliente para CRMDev" lines={2}/>
      : reviewing(crmdev) ? <CrmdevReview change={crmdev} onCancel={close} onReview={close} page="clientes" linkLabel="Enlazar con el existente"
        onLink={crmdevId => void link(async () => { await refreshForLink(); await linkCrmdevClient(id, crmdevId, 'linked'); }, 'Enlazado con el cliente que ya tenía CRMDev.')}/>
      : <>{crmdev.error && <p className="error" role="alert">{crmdev.error}</p>}
        <div className="actions"><button type="button" className="button" onClick={close}>Cerrar</button></div></>)}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
