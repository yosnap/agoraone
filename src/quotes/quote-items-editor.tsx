import { useState } from 'react';
import { emptyItem, emptyPhase, itemFromRate, type ItemFields, type PhaseFields, type Rate } from '../api/quotes';
import { ModernSelect } from '../ui/modern-select';
import { euros } from '../api/quotes';

const replace = <T,>(list: T[], index: number, change: Partial<T>) => list.map((entry, n) => (n === index ? { ...entry, ...change } : entry));

/** The lines of a new draft: typed by hand or taken from one of Central's rates (name, unit and price without VAT). */
export function QuoteItemsEditor({ items, onChange, rates }: { items: ItemFields[]; onChange: (items: ItemFields[]) => void; rates: Rate[] | null }) {
  const [rateId, setRateId] = useState('');
  const usable = (rates ?? []).filter((r): r is Rate & { id: string } => Boolean(r.id && r.name));
  const chosen = usable.find(r => r.id === rateId);
  return <fieldset className="quotes-fieldset">
    <legend>Partidas (precios sin IVA)</legend>
    {items.map((item, index) => <div key={index} className="quotes-item">
      <label className="field quotes-wide">Concepto<input value={item.description} maxLength={500} onChange={e => onChange(replace(items, index, { description: e.target.value }))}/></label>
      <label className="field">Cantidad<input value={item.quantity} inputMode="decimal" maxLength={14} onChange={e => onChange(replace(items, index, { quantity: e.target.value }))}/></label>
      <label className="field">Unidad<input value={item.unit} maxLength={30} placeholder="proyecto, mes…" onChange={e => onChange(replace(items, index, { unit: e.target.value }))}/></label>
      <label className="field">Precio<input value={item.unitPrice} inputMode="decimal" maxLength={14} placeholder="1.200,00" onChange={e => onChange(replace(items, index, { unitPrice: e.target.value }))}/></label>
      <label className="field">Precio máximo<input value={item.priceMax} inputMode="decimal" maxLength={14} placeholder="Si es un rango" onChange={e => onChange(replace(items, index, { priceMax: e.target.value }))}/></label>
      <label className="field quotes-wide">Detalle<textarea rows={2} value={item.details} maxLength={3000} onChange={e => onChange(replace(items, index, { details: e.target.value }))}/></label>
      <div className="actions central-actions"><button type="button" className="button" disabled={items.length === 1} onClick={() => onChange(items.filter((_, n) => n !== index))}>Quitar partida</button></div>
    </div>)}
    <div className="field-row quotes-add">
      <label className="field">Tarifa de Central<ModernSelect value={rateId} onChange={setRateId} disabled={!usable.length}
        options={[{ value: '', label: rates === null ? 'Leyendo las tarifas…' : usable.length ? 'Elige una tarifa' : 'Central no tiene tarifas' },
          ...usable.map(r => ({ value: r.id, label: `${r.name} · ${euros(r.price)}${r.unit ? ` / ${r.unit}` : ''}` }))]}/></label>
      <div className="actions central-actions">
        <button type="button" className="button" disabled={!chosen || items.length >= 100} onClick={() => { if (chosen) { onChange([...items, itemFromRate(chosen)]); setRateId(''); } }}>Añadir la tarifa</button>
        <button type="button" className="button" disabled={items.length >= 100} onClick={() => onChange([...items, emptyItem()])}>Añadir a mano</button>
      </div>
    </div>
  </fieldset>;
}

/** The payment milestones (Central's «fases»): a name, a percentage of the total and, if wanted, a day. */
export function QuotePhasesEditor({ phases, onChange }: { phases: PhaseFields[]; onChange: (phases: PhaseFields[]) => void }) {
  return <fieldset className="quotes-fieldset">
    <legend>Hitos de pago</legend>
    {!phases.length && <p className="muted">Sin hitos: el pago se acuerda en Central.</p>}
    {phases.map((phase, index) => <div key={index} className="quotes-item">
      <label className="field quotes-wide">Hito<input value={phase.name} maxLength={200} placeholder="Al aceptar, a la entrega…" onChange={e => onChange(replace(phases, index, { name: e.target.value }))}/></label>
      <label className="field">Porcentaje<input value={phase.percent} inputMode="decimal" maxLength={6} placeholder="50" onChange={e => onChange(replace(phases, index, { percent: e.target.value }))}/></label>
      <label className="field">Fecha<input type="date" value={phase.dueDate} min="2000-01-01" max="2100-12-31" onChange={e => onChange(replace(phases, index, { dueDate: e.target.value }))}/></label>
      <div className="actions central-actions"><button type="button" className="button" onClick={() => onChange(phases.filter((_, n) => n !== index))}>Quitar hito</button></div>
    </div>)}
    <div className="actions central-actions"><button type="button" className="button" disabled={phases.length >= 50} onClick={() => onChange([...phases, emptyPhase()])}>Añadir hito</button></div>
  </fieldset>;
}
