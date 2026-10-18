import { useState } from 'react';

export type ConsultTarget = { id: string; label: string };

// Picks who reads the attachment: Luma or any detected profile. Choosing only attaches it to
// that chat; nothing is sent until the user writes and sends a message there.
export function ConsultWith({ what, targets, onConsult }: { what: string; targets: ConsultTarget[]; onConsult: (target: string) => void }) {
  const [target, setTarget] = useState(targets[0]?.id ?? 'library');
  const chosen = targets.find(item => item.id === target) ?? targets[0];
  if (!chosen) return null;
  return <div className="consult-with">
    {targets.length > 1 && <><label htmlFor="consult-target">Consultar con</label>
      <select id="consult-target" value={chosen.id} onChange={event => setTarget(event.target.value)}>{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></>}
    <button className="primary" onClick={() => onConsult(chosen.id)}>Consultar {what} con {chosen.label}</button>
  </div>;
}
