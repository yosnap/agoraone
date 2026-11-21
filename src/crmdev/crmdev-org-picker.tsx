import type { CrmdevOrg } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';

// The organization of CRMDev the section shows. A key fixes one organization and CRMDev does not say which, so the user
// names each one in Conectores › CRMDev; here only those with a key can be read. The choice is remembered in this
// browser only (a convenience: without storage the first one is shown).

const STORED = 'agoraone.crmdev.org';

export function rememberedOrg(): string {
  try { return localStorage.getItem(STORED) ?? ''; } catch { return ''; }
}

export function rememberOrg(org: string) {
  try { localStorage.setItem(STORED, org); } catch { /* without storage: only for this visit */ }
}

/** The organization to show: the chosen one if it can still be read, else the first one with a key. */
export function pickOrg(orgs: CrmdevOrg[], chosen: string): CrmdevOrg | undefined {
  const usable = orgs.filter(o => o.hasKey);
  return usable.find(o => o.id === chosen) ?? usable[0];
}

/** «Organización de CRMDev» above the tabs, only with more than one organization. */
export function CrmdevOrgPicker({ orgs, org, onChange }: { orgs: CrmdevOrg[]; org: CrmdevOrg | undefined; onChange: (org: string) => void }) {
  const usable = orgs.filter(o => o.hasKey);
  const keyless = orgs.filter(o => !o.hasKey);
  if (usable.length < 2 && !keyless.length) return null;
  return <div className="crmdev-org-picker">
    {usable.length > 1 && <label className="field">Organización de CRMDev
      <ModernSelect value={org?.id ?? ''} onChange={onChange} options={usable.map(o => ({ value: o.id, label: o.name }))}/></label>}
    {usable.length === 1 && <span className="muted">Organización «{usable[0].name}»</span>}
    {keyless.length > 0 && <small className="muted">Sin clave: {keyless.map(o => `«${o.name}»`).join(', ')}. Añádela en Conectores › CRMDev para verla aquí.</small>}
  </div>;
}
