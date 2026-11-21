import { useRef, useState } from 'react';
import { createOrcaMailbox, getOrcaBots, type OrcaBots } from '../api/orca-bots';
import { ActionButton } from '../ui/action-button';

const mailboxText = { ready: 'Listo', missing: 'Sin crear', broken: 'No se puede usar' } as const;

/** The user's bots in Orca and AgoraOne's mailbox there. The bots are created and set up in Orca (one per kind of job:
 * security, junior development, review, support…); here they are only listed. The mailbox is created only with the
 * button, as a visible tab in Orca that runs `cat`. */
export function OrcaBotsPanel({ discreet }: { discreet: boolean }) {
  const [data, setData] = useState<OrcaBots | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => { void getOrcaBots().then(setData).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer Orca.')); };
  if (!asked.current) { asked.current = true; load(); }
  if (!data || !data.on) return null;
  const create = async () => {
    setBusy(true); setError('');
    try { await createOrcaMailbox(); load(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo crear el buzón.'); }
    finally { setBusy(false); }
  };
  const mailbox = data.mailbox;
  return <section className="orca-bots" aria-labelledby="orca-bots-title">
    <div className="card-head"><h2 id="orca-bots-title">Bots de Orca</h2>
      <ActionButton icon="refresh" label="Comprobar" disabled={busy} onClick={load}/></div>
    <p className="muted">Bots que tienes en Orca, uno por oficio (seguridad, desarrollo, revisión, soporte…). Se crean y configuran en Orca; AgoraOne les envía encargos desde su buzón y lee sus respuestas.</p>
    {data.problem && <p className="notice">{data.problem}</p>}
    {mailbox && <div className="card coding-row orca-mailbox">
      <span className={`chip orca-mailbox-state ${mailbox.state}`}>{mailboxText[mailbox.state]}</span>
      <span className="coding-name"><strong>{mailbox.title}</strong>
        <small>{mailbox.state === 'ready' ? `Pestaña en Orca${mailbox.where && !discreet ? ` · ${mailbox.where}` : ''}. Solo recibe respuestas: no escribas en ella.`
          : mailbox.problem ?? 'Hace falta para enviar encargos a los bots: es una pestaña de Orca que solo recibe sus respuestas.'}</small></span>
      {mailbox.state !== 'ready' && <ActionButton icon="plus" label="Crear el buzón de AgoraOne" disabled={busy} onClick={() => void create()}/>}
    </div>}
    {!data.problem && (data.bots.length === 0 ? <p className="muted">Aún no tienes bots en Orca: créalos desde su barra lateral «Bots».</p>
      : <ul className="coding-list">{data.bots.map(bot => <li key={bot.id} className="card coding-row">
        <span className={`chip ${bot.paused ? '' : 'coding-state working'}`}>{bot.paused ? 'En pausa' : 'Activo'}</span>
        <span className="coding-name"><strong>{bot.name}</strong><small>{bot.agent ?? 'agente desconocido'}{bot.purpose ? ` · ${bot.purpose}` : ''}</small></span>
      </li>)}</ul>)}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
