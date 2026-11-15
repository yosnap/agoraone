import type { Category, FiscalFolder, FolderKind, InvoiceFields } from '../api/core';
import { ModernSelect } from '../ui/modern-select';

/** The total as the core writes it in the name (same rule as its `amount`): «1.234,5» → «1234,50». */
function shownTotal(value: string) {
  let text = value.replace(/[^\d,.-]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  else if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (text.includes(',')) text = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const number = Number(text);
  return text && Number.isFinite(number) ? number.toFixed(2).replace('.', ',') : null;
}

/** Where the core will put it, from the fields as edited (the core decides; this is the same rule). */
export function place(fields: InvoiceFields, kind: FolderKind = 'autonomo', category: Category | null = null, suffix = '.pdf') {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(fields.issuedOn);
  if (!match) return null;
  const total = shownTotal(fields.total);
  // eslint-disable-next-line no-control-regex
  const supplier = fields.supplier.replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 60) || 'Proveedor';
  if (!total) return null;
  const name = `${fields.issuedOn} ${supplier} ${total}${suffix}`;
  return kind === 'personal' ? `${category === 'compras' ? 'Compras' : 'Gastos'}/${match[1]}/${name}`
    : `Facturas Entrantes/${match[1]}/${Math.floor((Number(match[2]) - 1) / 3) + 1}T/${name}`;
}

/** The editable data of an invoice or receipt. */
export function DocumentFields({ fields, onChange }: { fields: InvoiceFields; onChange: (fields: InvoiceFields) => void }) {
  const set = (key: keyof InvoiceFields) => (event: { target: { value: string } }) => onChange({ ...fields, [key]: event.target.value });
  return <div className="mail-account-fields">
    <label className="field">Proveedor o comercio<input value={fields.supplier} onChange={set('supplier')} maxLength={120}/></label>
    <label className="field">NIF<input value={fields.taxId ?? ''} onChange={set('taxId')} maxLength={20}/></label>
    <label className="field">Fecha<input type="date" value={fields.issuedOn} onChange={set('issuedOn')}/></label>
    <label className="field">Total<input value={fields.total} onChange={set('total')} maxLength={20} inputMode="decimal"/></label>
    <label className="field">Moneda<input value={fields.currency} onChange={set('currency')} maxLength={3}/></label>
  </div>;
}

/** Which fiscal folder it goes to and, in a personal one, whether it is an expense or a purchase. */
export function FolderChoice({ folders, folderId, category, onFolder, onCategory }: {
  folders: FiscalFolder[]; folderId: number | null; category: Category | null; onFolder: (id: number) => void; onCategory: (category: Category) => void;
}) {
  const folder = folders.find(item => item.id === folderId);
  return <div className="mail-account-fields">
    <label className="field">Carpeta<ModernSelect value={folderId ? String(folderId) : ''} onChange={value => onFolder(Number(value))}
      options={[...(folderId ? [] : [{ value: '', label: 'Elige una carpeta' }]), ...folders.map(item => ({ value: String(item.id), label: item.name }))]}/></label>
    {folder?.kind === 'personal' && <label className="field">Es un<ModernSelect value={category ?? ''} onChange={value => onCategory(value as Category)}
      options={[...(category ? [] : [{ value: '', label: 'Elige' }]), { value: 'gastos', label: 'Gasto' }, { value: 'compras', label: 'Compra' }]}/></label>}
  </div>;
}
