import { useRef, useState } from 'react';
import { getWritePermissions } from '../api/central-write';
import { confirmCentralBatch, dismissBirth, getClientBirths, getClients, previewCentralBatch, type ClientBirth, type ClientsDirectory } from '../api/clients';
import { invalidateClients } from '../data/clients-store';
import { birthText, centralCandidates } from '../jobs/clients-view';
import { LoadError, Loading } from '../ui/load-state';
import { BatchReview } from './batch-review';
import { SyncTable, type SyncGroup, type SyncItem, type SyncRow } from './sync-table';

type Loaded = { clients: ClientsDirectory; births: { items: ClientBirth[]; dismissed: number }; canWrite: boolean };

/** «Por crear» in the Central section: clients are born in Central. The clients kept only in AgoraOne, the clients of
 * CRMDev that are not in Central and the proposals from mail, WhatsApp and meetings (only what is «normal»; never an
 * address nor a number on this list). Ticked, reviewed exactly and created with «Crear en Central»; nothing by itself. */
export function CentralToCreate({ discreet, onChanged }: { discreet: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [withDismissed, setWithDismissed] = useState(false);
  const [reviewing, setReviewing] = useState<SyncItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const load = (all = withDismissed) => {
    Promise.all([getClients(discreet), getClientBirths(all), getWritePermissions().then(p => p.central).catch(() => false)])
      .then(([clients, births, canWrite]) => { setData({ clients, births, canWrite }); setError(''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los clientes por crear.'));
  };
  if (!asked.current) { asked.current = true; load(false); }
  if (!data) return error ? <LoadError message={error} onRetry={() => load()}/> : <Loading label="Buscando clientes por crear" lines={3}/>;
  const { local, crmdev } = centralCandidates(data.clients.clients);
  const company = (name: string, other: string | null) => (other && other !== name ? other : null);
  const groups: SyncGroup[] = [
    { id: 'propuestas', label: 'Propuestas', hint: 'Quien te escribe (correos y WhatsApp de cliente o de trabajo) o se reúne contigo y aún no es cliente. Puedes cambiar el nombre al marcarlo.',
      rows: data.births.items.map((b): SyncRow => ({ key: b.key, name: b.name, detail: birthText(b), selectable: true, dismissed: b.dismissed, editableName: true, dismissable: true })) },
    { id: 'agoraone', label: 'De AgoraOne', hint: 'Clientes que guardas en AgoraOne y no están en Central: al crearlos quedan enlazados.',
      rows: local.map((c): SyncRow => ({ key: `local:${c.localId}`, name: c.name, detail: company(c.name, c.company), selectable: true })) },
    { id: 'crmdev', label: 'De CRMDev', hint: 'Clientes de CRMDev que no están en Central: al crearlos quedan enlazados con el de CRMDev.',
      rows: crmdev.map((c): SyncRow => ({ key: `crmdev:${c.crmdevId}`, name: c.name, detail: company(c.name, c.company), selectable: true })) },
  ];
  const dismiss = async (row: SyncRow) => {
    const birth = data.births.items.find(b => b.key === row.key);
    if (!birth) return;
    setBusy(true); setError('');
    try { await dismissBirth(birth.key, !birth.dismissed); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  return <section className="sync-section" aria-label="Por crear en Central">
    <p className="muted">Tus clientes nacen en Central. Marca los que quieras crear, revisa cada uno tal cual irá y pulsa «Crear en Central». Las propuestas salen de
      correos, WhatsApp y reuniones, nunca de lo «solo en este Mac» ni de lo privado; nada se crea solo.</p>
    {!data.canWrite && <p className="notice">Para crear en Central hace falta una clave con el permiso «escritura» (Conectores › Central).</p>}
    {error && <LoadError message={error}/>}
    {reviewing && <BatchReview key={reviewing.map(i => i.key).join('|')} onClose={() => setReviewing(null)}
      onDone={() => { invalidateClients(); load(); onChanged?.(); }}
      dest={{ name: 'Central', action: 'Crear en Central', preview: anyway => previewCentralBatch(reviewing, anyway), confirm: confirmCentralBatch }}/>}
    <SyncTable groups={groups} discreet={discreet || !data.canWrite} busy={busy || reviewing !== null} reviewLabel="Revisar" onReview={setReviewing}
      onDismiss={row => void dismiss(row)} empty="Nada por crear en Central."
      tools={data.births.dismissed > 0 && <button type="button" className="button" aria-pressed={withDismissed}
        onClick={() => { setWithDismissed(!withDismissed); load(!withDismissed); }}>{withDismissed ? 'Ocultar descartadas' : `Ver descartadas (${data.births.dismissed})`}</button>}/>
  </section>;
}
