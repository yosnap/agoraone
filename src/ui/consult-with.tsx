import { useState } from 'react';
import { ModernSelect } from './modern-select';

export type ConsultTarget = { id: string; label: string; color?: string };

// Picks who reads the attachment: Luma or any detected profile. Choosing only attaches it to
// that chat; nothing is sent until the user writes and sends a message there.
export function ConsultWith({ what, targets, onConsult }: { what: string; targets: ConsultTarget[]; onConsult: (target: string) => void }) {
  const [target, setTarget] = useState(targets[0]?.id ?? 'library');
  const chosen = targets.find(item => item.id === target) ?? targets[0];
  const options = targets.map(item => ({ value: item.id, label: item.label,
    render: <><span className="ms-dot" style={{ background: item.color ?? '#9a93a8' }} aria-hidden="true"/><span className="ms-text">{item.label}</span></> }));
  if (!chosen) return null;
  return <div className="consult-with">
    {targets.length > 1 && <><label htmlFor="consult-target">Consultar con</label><ModernSelect id="consult-target" value={chosen.id} onChange={setTarget} options={options}/></>}
    <button className="primary" onClick={() => onConsult(chosen.id)}>Consultar {what} con {chosen.label}</button>
  </div>;
}
