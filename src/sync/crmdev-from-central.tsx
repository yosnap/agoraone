import { useRef, useState } from 'react';
import { refreshCentral } from '../api/core';
import { refreshCrmdevClients } from '../api/crmdev';
import { assignCrmdevOrg, confirmBatch, dismissPending, getCrmdevPending, previewBatch, type CrmdevPending, type PendingItem, type PendingKind } from '../api/clients';
import { pendingChangeText, pendingText } from '../jobs/clients-view';
import { ActionButton } from '../ui/action-button';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { BatchReview } from './batch-review';
import { SyncTable, type SyncGroup, type SyncItem, type SyncRow, type SyncSecondary } from './sync-table';

export const KIND_LABELS: Record<string, string> = { CLIENT: 'De cliente', OWN: 'Propio', TRAINING: 'Formación', EXPERIMENT: 'Experimento' };
export const CENTRAL_STATUS: Record<string, string> = { ACTIVE: 'Activo', MAINTENANCE: 'Mantenimiento', DORMANT: 'En pausa', ARCHIVED: 'Archivado' };
const SENDABLE = new Set<PendingKind>(['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed']);
const GROUPS: { kind: PendingKind; label: string; hint: string }[] = [
  { kind: 'client_missing', label: 'Clientes que faltan', hint: 'Clientes de Central que no están en CRMDev: se crean con su nombre, correo, empresa y teléfono (nunca el NIF ni la dirección). Envíalos antes que sus proyectos.' },
  { kind: 'project_missing', label: 'Proyectos que faltan', hint: 'Proyectos de Central que no están en CRMDev. Cada uno se enlaza solo con su cliente de CRMDev; si su cliente aún no está, se avisa y queda sin cliente: envía antes los clientes.' },
  { kind: 'contact_missing', label: 'Contactos que faltan', hint: 'El correo de contacto de Central no está en CRMDev: se añade al cliente o se crea una persona de esa empresa.' },
  { kind: 'client_changed', label: 'Clientes distintos', hint: 'Clientes con nombre, empresa o correo distintos: CRMDev se pone como Central.' },
  { kind: 'project_changed', label: 'Proyectos distintos', hint: 'Proyectos con nombre o estado distintos: CRMDev se pone como Central (el cliente se cambia en CRMDev).' },
  { kind: 'crmdev_only', label: 'Solo en CRMDev', hint: 'Clientes de CRMDev que no están en Central: se crean en Central, en Central › Por crear.' },
];

export const UNPLACED_CLIENTS = 'unplaced_clients';
export const UNPLACED_PROJECTS = 'unplaced_projects';
const isProject = (item: PendingItem) => item.kind === 'project_missing' || item.kind === 'project_changed';

/** «Sin organización» split in two, clients apart from projects, so that each goes on its own (clients first). */
export function unplacedGroups(unplaced: PendingItem[], orgName: string): { id: string; label: string; hint: string; items: PendingItem[] }[] {
  const tail = `Lo que envíes desde aquí va a «${orgName}» y queda como suyo; también puedes asignarlo sin enviar.`;
  return [
    { id: UNPLACED_CLIENTS, label: 'Clientes sin organización', items: unplaced.filter(i => !isProject(i)),
      hint: `Clientes de Central que aún no tienen organización de CRMDev. Envíalos antes que sus proyectos. ${tail}` },
    { id: UNPLACED_PROJECTS, label: 'Proyectos sin organización', items: unplaced.filter(isProject),
      hint: `Proyectos de Central que aún no tienen organización de CRMDev. Cada uno se enlaza solo con su cliente de CRMDev; si su cliente aún no está, se avisa y queda sin cliente. ${tail}` },
  ];
}
const ASSIGNABLE = new Set<PendingKind>(['client_missing', 'project_missing']);

/** With several organizations: what is about the chosen one, and what is about none yet («Sin organización»). With
 * one, everything is about it. */
export function byOrg(items: PendingItem[], org: string | undefined, several: boolean): { mine: PendingItem[]; unplaced: PendingItem[] } {
  if (!several) return { mine: items, unplaced: [] };
  return { mine: items.filter(i => i.org === org), unplaced: items.filter(i => !i.org) };
}

/** A missing project: whether its client is not in CRMDev yet (it would go without one) and a look-alike to link. */
export function projectDetail(item: PendingItem): string | null {
  const parts = [
    item.client && item.clientInCrmdev === false ? `Su cliente aún no está en CRMDev: envía antes los clientes o quedará sin cliente.` : '',
    item.maybe ? `Quizá es «${item.maybe}» de CRMDev: enlázalo en su ficha.` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** The name AgoraOne gives an organization until the user names it («Organización 1»). */
export const defaultOrgName = (name: string) => /^Organización \d+$/.test(name);

/** The review button of each group: clients and projects go apart, clients first. */
export const reviewLabelOf = (groupId: string) =>
  groupId === 'client_missing' || groupId === UNPLACED_CLIENTS ? 'Enviar clientes'
    : groupId === 'project_missing' || groupId === UNPLACED_PROJECTS ? 'Enviar proyectos' : 'Revisar envío';

const rowOf = (item: PendingItem): SyncRow => ({
  key: item.key, name: item.name, selectable: SENDABLE.has(item.kind), dismissed: item.dismissed, dismissable: true,
  client: item.kind === 'project_missing' ? item.client ?? null : undefined,
  kind: item.kind === 'project_missing' ? (item.projectKind ? KIND_LABELS[item.projectKind] ?? item.projectKind : null) : undefined,
  status: item.kind === 'project_missing' && item.status ? CENTRAL_STATUS[item.status] ?? item.status : undefined,
  detail: item.kind === 'project_missing' ? projectDetail(item)
    : item.kind === 'client_changed' || item.kind === 'project_changed' ? null : pendingText(item),
  changes: item.changes?.map(pendingChangeText),
});

/** «Desde Central» in the CRMDev section: what Central has and CRMDev lacks or has otherwise, by groups, to tick and
 * send with «Enviar a CRMDev» after seeing the exact review. Central is the source: nothing comes back from CRMDev. */
export function CrmdevFromCentral({ discreet, onChanged, org: shown }: { discreet: boolean; onChanged?: () => void;
  /** The organization the CRMDev section shows: then it is not chosen here. */ org?: string }) {
  const [data, setData] = useState<CrmdevPending | null>(null);
  const [error, setError] = useState('');
  const [withDismissed, setWithDismissed] = useState(false);
  const [reviewing, setReviewing] = useState<{ items: SyncItem[]; org: string | undefined } | null>(null);
  const [chosenOrg, setChosenOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const load = (all = withDismissed) => {
    getCrmdevPending(all).then(found => { setData(found); setError(''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo comparar con Central.'));
  };
  /** «Comparar de nuevo» reads Central and CRMDev now: comparing older copies would hide what just changed. */
  const compareAgain = async () => {
    setBusy(true);
    await Promise.allSettled([refreshCentral(), refreshCrmdevClients()]);
    setBusy(false);
    load();
  };
  if (!asked.current) { asked.current = true; load(false); }
  if (!data) return error ? <LoadError message={error} onRetry={() => load()}/> : <Loading label="Comparando Central y CRMDev" lines={3}/>;
  if (!data.active) return <p className="muted">Para comparar, enciende y lee Central (Conectores) y vuelve a leer CRMDev.</p>;
  const dismiss = async (row: SyncRow) => {
    const item = data.items.find(i => i.key === row.key);
    if (!item) return;
    setBusy(true); setError('');
    try { await dismissPending(item.key, item.dismissed ? null : item.signature); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const orgs = data.orgs ?? [];
  const several = orgs.length > 1;
  const org = orgs.find(o => o.id === (shown ?? chosenOrg)) ?? orgs[0];
  const { mine, unplaced } = byOrg(data.items, org?.id, several);
  const groups: SyncGroup[] = GROUPS.map(g => ({ id: g.kind, label: g.label, hint: g.hint, rows: mine.filter(i => i.kind === g.kind).map(rowOf) }));
  if (several) groups.push(...unplacedGroups(unplaced, org?.name ?? '').map(g => ({ id: g.id, label: g.label, hint: g.hint, rows: g.items.map(rowOf) })));
  const pendingCount = (id: string) => data.items.filter(i => i.org === id && !i.dismissed).length;
  const assign = async (items: SyncItem[], to: string | null) => {
    const keys = items.map(i => i.key).filter(key => {
      const item = data.items.find(i => i.key === key);
      return item && ASSIGNABLE.has(item.kind) && (to !== null || item.orgFrom === 'chosen');
    });
    if (!keys.length) { setError(to ? 'Solo se asigna lo que aún falta en CRMDev.' : 'Solo se quita una organización elegida a mano: la de un enlace la decide el enlace.'); return; }
    setBusy(true); setError('');
    try { await assignCrmdevOrg(keys, to); load(); onChanged?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const secondary = (groupId: string): SyncSecondary | null => !several || !org ? null
    : groupId === UNPLACED_CLIENTS || groupId === UNPLACED_PROJECTS ? { label: `Asignar a «${org.name}»`, onRun: items => void assign(items, org.id) }
      : ASSIGNABLE.has(groupId as PendingKind) ? { label: 'Dejar sin organización', onRun: items => void assign(items, null) } : null;
  return <section className="sync-section" aria-label="Desde Central">
    <p className="muted">Central manda: aquí está lo que tiene Central y falta o es distinto en CRMDev. Cada grupo se envía por separado: primero los clientes y
      luego los proyectos, que se enlazan solos con su cliente de CRMDev. Marca lo que quieras, revisa exactamente qué irá y envíalo.{several ? ' Cada cliente y proyecto va a una sola organización de CRMDev: elige abajo con cuál comparar.' : ''}{data.truncated ? ' De CRMDev se leen los 1000 más recientes: puede faltar algo que sí está.' : ''}</p>
    {error && <LoadError message={error}/>}
    {reviewing && <BatchReview key={`${reviewing.org}|${reviewing.items.map(i => i.key).join('|')}`} onClose={() => setReviewing(null)}
      onDone={() => { load(); onChanged?.(); }}
      dest={{ name: 'CRMDev', action: 'Enviar a CRMDev', preview: anyway => previewBatch(reviewing.items.map(i => i.key), anyway, reviewing.org), confirm: confirmBatch }}/>}
    <SyncTable key={org?.id ?? ''} groups={groups} discreet={discreet} busy={busy || reviewing !== null} reviewLabel={groupId => org ? `${reviewLabelOf(groupId)} a «${org.name}»` : reviewLabelOf(groupId)} byGroup
      onReview={items => setReviewing({ items, org: org?.id })} secondary={secondary}
      above={<div className="sync-org-picker">
        {org && <p className="sync-org" role="note">Se envía a la organización de CRMDev <strong>«{org.name}»</strong>.
          {defaultOrgName(org.name) && <> Es el nombre que AgoraOne le pone de entrada: cámbialo en Conectores › CRMDev para reconocerla.</>}</p>}
        {several && !shown && <label className="field">Organización de CRMDev<ModernSelect value={org?.id ?? ''} onChange={setChosenOrg}
            options={orgs.map(o => ({ value: o.id, label: `${o.name} · ${pendingCount(o.id)}` }))}/></label>}
        {several && unplaced.length > 0 && <small className="muted">{unplaced.length} sin organización</small>}
      </div>}
      onDismiss={row => void dismiss(row)} empty="Todo al día: CRMDev tiene lo mismo que Central."
      tools={<>
        {data.dismissed > 0 && <button type="button" className="button" aria-pressed={withDismissed}
          onClick={() => { setWithDismissed(!withDismissed); load(!withDismissed); }}>{withDismissed ? 'Ocultar descartados' : `Ver descartados (${data.dismissed})`}</button>}
        <ActionButton icon="refresh" label="Comparar de nuevo" disabled={busy} onClick={() => void compareAgain()}/>
      </>}/>
  </section>;
}
