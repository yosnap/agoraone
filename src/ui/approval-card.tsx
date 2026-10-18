import { useState } from 'react';
import { answerApproval, type ToolApproval } from '../api/client';

// A tool call the profile wants to make: it only runs if the user allows it here. Denying, or not
// answering before Hermes' own timeout, tells the profile the action was not authorised.
export function ApprovalCard({ conversationId, approval, label, onAnswered }: {
  conversationId: string; approval: ToolApproval; label: string; onAnswered: (choice: 'once' | 'deny') => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const id = `approval-${approval.requestId}`;
  async function answer(choice: 'once' | 'deny') {
    setSending(true); setError('');
    try { await answerApproval(conversationId, approval.requestId, choice); onAnswered(choice); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo enviar la respuesta.'); setSending(false); }
  }
  return <section className="approval-card" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`}>
    <strong id={`${id}-title`}>{label} quiere usar <code>{approval.tool}</code></strong>
    {approval.expired ? <p id={`${id}-help`} className="error">{approval.expired === 'timeout' ? 'Caducada: Hermes la denegó al no recibir respuesta a tiempo.' : 'Cancelada: el turno se detuvo o terminó antes de responder.'} No se ha ejecutado.</p> : <>
      <p id={`${id}-help`}>Solo se ejecuta si lo permites. Revisa los datos que va a usar:</p>
      {approval.args && <pre>{approval.args}</pre>}
      {approval.redacted && <p className="approval-warning">Se han ocultado fragmentos que parecen claves. Si no puedes juzgar qué hace sin verlos, deniégalo.</p>}
      {approval.truncated && <p className="approval-warning">Solo se muestran los primeros 12 000 de {approval.length.toLocaleString('es')} caracteres. Lo que no ves también se ejecutaría: si dudas, deniégalo.</p>}
      {approval.rewritable && <p className="approval-warning">Este perfil tiene complementos que pueden modificar estos datos antes de ejecutarse.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div>{/* Denying is the safe choice, so it takes the focus first. */}<button type="button" autoFocus disabled={sending} onClick={() => answer('deny')}>Denegar</button><button type="button" className="primary" disabled={sending} onClick={() => answer('once')}>Permitir</button></div>
    </>}
  </section>;
}
