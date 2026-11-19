import { useRef, useState, type FormEvent } from 'react';
import {
  changeChatAccount, getChatSettings, getScopes, levelLabels, putChatKey, syncChat, testChat,
  type ChatAccount, type ChatSettings, type ChatSyncResult, type Level, type Scope,
} from '../api/core';
import { META_COST_NOTICE } from '../inbox/chat-reply-text';
import { ModernSelect } from '../ui/modern-select';
import { Loading, LoadError } from '../ui/load-state';
import { WhatsAppRulesCard } from './settings-whatsapp-rules';

const statusLabels: Record<ChatAccount['status'], string> = {
  pending: 'Pendiente de leer', ok: 'Conectada', auth: 'Revisa la clave', unreachable: 'Sin conexión', error: 'Error',
};
const levels = (['normal', 'local_only', 'private'] as const).map(level => ({ value: level, label: levelLabels[level] }));
const DAYS = [7, 30, 60, 90, 180, 365];
const syncNotes: Record<ChatSyncResult['status'], string> = {
  ok: '', busy: 'Ya se estaba leyendo WhatsApp; espera un momento.', auth: 'Zernio no aceptó la clave.',
  unreachable: 'No se pudo hablar con Zernio ahora.', error: 'Zernio respondió con un error.',
};

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
}

function readNote(result: ChatSyncResult): string {
  if (result.status !== 'ok') return result.error ?? syncNotes[result.status];
  if (!result.accounts) return 'Zernio no tiene ninguna cuenta de WhatsApp conectada.';
  const added = `Leídos ${result.added} mensajes nuevos de ${result.read} conversaciones.`;
  const pending = result.pending ? ` Quedan ${result.pending} conversaciones por completar: llegan en las próximas lecturas.` : '';
  const skipped = result.skipped ? ` ${result.skipped} no se pudieron leer ahora; se reintentarán.` : '';
  return `${added}${pending}${skipped}`;
}

/** Settings › WhatsApp: the connection and, below, the rules for its conversations. */
export function WhatsAppSettingsCard() {
  return <><WhatsAppConnectionCard/><WhatsAppRulesCard/></>;
}

/** WhatsApp through Zernio: the key goes to the Keychain and is never shown again; each account has its scope,
 * confidentiality and days back. Reading never marks anything as read; a reply leaves only from a card, after its
 * exact preview and «Enviar», and Meta's charge for it is stated here. */
function WhatsAppConnectionCard() {
  const [state, setState] = useState<ChatSettings | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  const load = () => {
    setError('');
    Promise.all([getChatSettings(), getScopes()]).then(([found, known]) => { setState(found); setScopes(known.scopes); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer el ajuste de WhatsApp.'));
  };
  if (!asked.current) { asked.current = true; load(); }
  /** Runs one action; `work` returns the new settings (or null) and the note to show. */
  const run = async (name: string, work: () => Promise<[ChatSettings | null, string]>) => {
    setBusy(name); setError(''); setNote('');
    try { const [next, said] = await work(); if (next) setState(next); setNote(said); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); return false; }
    finally { setBusy(null); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run('key', async () => [await putChatKey(key.trim()), 'Clave guardada en el Llavero. Pulsa «Probar» para comprobarla.']).then(ok => { if (ok) setKey(''); });
  };
  const change = (account: ChatAccount, changes: Parameters<typeof changeChatAccount>[1], said: string) =>
    void run(`account-${account.id}`, async () => [await changeChatAccount(account.id, changes), said]);
  if (!state) return <article className="card"><h2>WhatsApp</h2>{error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo el ajuste de WhatsApp"/>}</article>;
  const scopeOptions = [{ value: '', label: 'Sin ámbito' }, ...scopes.map(scope => ({ value: String(scope.id), label: scope.name }))];
  const dayOptions = (current: number) => [...new Set([...DAYS, current])].sort((a, b) => a - b).map(days => ({ value: String(days), label: `${days} días` }));
  return <article className="card settings-mail" aria-labelledby="whatsapp-title">
    <div className="card-head"><h2 id="whatsapp-title">WhatsApp (Zernio)</h2>
      <span className={`status-badge ${state.hasKey ? 'good' : 'paused'}`}>{state.hasKey ? 'Clave guardada' : 'Sin clave'}</span></div>
    <p>AgoraOne lee tu WhatsApp Business a través de Zernio sin marcar nada como leído, cada cinco minutos o al pulsar «Leer ahora». Solo envía un mensaje cuando respondes desde una tarjeta de la Bandeja, ves la vista previa exacta y pulsas «Enviar». El número se conecta en el panel de Zernio; aquí solo va su clave de API, que se guarda en el Llavero y no se vuelve a mostrar.</p>
    <p className="muted">Los grupos no llegan: con el número en modo «coexistence», WhatsApp solo entrega los chats individuales.</p>
    <p className="muted">{META_COST_NOTICE}</p>
    <form className="field-row" onSubmit={save}>
      <label className="field">{state.hasKey ? 'Cambiar la clave de API de Zernio' : 'Clave de API de Zernio'}
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="Va directa al Llavero"/></label>
      <button className="button primary" disabled={key.trim().length < 8 || busy !== null}>Guardar</button>
    </form>
    <div className="actions">
      <button type="button" className="button" disabled={!state.hasKey || busy !== null} onClick={() => void run('test', async () => {
        const found = await testChat();
        return [null, found.whatsapp ? `Clave válida: Zernio tiene ${found.whatsapp} ${found.whatsapp === 1 ? 'cuenta' : 'cuentas'} de WhatsApp.` : 'Clave válida, pero Zernio no tiene ninguna cuenta de WhatsApp conectada.'];
      })}>{busy === 'test' ? 'Probando…' : 'Probar'}</button>
      <button type="button" className="button" disabled={!state.hasKey || busy !== null} onClick={() => void run('sync', async () => {
        const answer = await syncChat();
        if (answer.result.status !== 'ok') { setState(answer); throw new Error(readNote(answer.result)); }
        return [answer, readNote(answer.result)];
      })}>{busy === 'sync' ? 'Leyendo…' : 'Leer ahora'}</button>
      {state.hasKey && (forgetting ? <span className="field-row" role="group" aria-label="Confirmar borrar la clave">
        <small>Se deja de leer WhatsApp; los mensajes ya guardados se conservan.</small>
        <button type="button" className="button danger" disabled={busy !== null} onClick={() => void run('key', async () => { setForgetting(false); return [await putChatKey(null), 'Clave borrada del Llavero.']; })}>Borrar de verdad</button>
        <button type="button" className="button" onClick={() => setForgetting(false)}>Cancelar</button></span>
        : <button type="button" className="button danger" disabled={busy !== null} onClick={() => setForgetting(true)}>Borrar la clave…</button>)}
    </div>
    {state.lastSync && <small className="muted">Última lectura: {when(state.lastSync.at)}{state.lastSync.status === 'ok' ? ` · ${state.lastSync.added} mensajes nuevos` : ` · ${statusLabels[state.lastSync.status === 'busy' ? 'pending' : state.lastSync.status]}`}</small>}
    {state.accounts.length ? <ul className="mail-accounts">{state.accounts.map(account => <li key={account.id}>
      <div className="compact-row">
        <span className="compact-name"><strong>{account.phone ?? account.label ?? 'Cuenta de WhatsApp'}</strong>
          <small className="muted">{account.label && account.phone ? `${account.label} · ` : ''}{account.conversations} conversaciones · {account.messages} mensajes · {when(account.lastSyncAt)}</small></span>
        <span className={`status-badge ${!account.enabled ? 'paused' : account.status === 'ok' ? 'good' : account.status === 'pending' ? 'waiting' : 'bad'}`}>
          {account.enabled ? statusLabels[account.status] : 'En pausa'}</span>
      </div>
      {account.lastError && account.status !== 'ok' && <small className="mail-error">{account.lastError}</small>}
      <div className="mail-account-fields">
        <label className="field">Ámbito<ModernSelect value={account.scopeId ? String(account.scopeId) : ''} options={scopeOptions} disabled={busy !== null}
          onChange={value => change(account, { scopeId: value ? Number(value) : null }, 'Ámbito guardado.')}/></label>
        <label className="field">Nivel<ModernSelect value={account.confidentiality} options={levels} disabled={busy !== null}
          onChange={value => change(account, { confidentiality: value as Level }, 'Nivel guardado.')}/></label>
        <label className="field">Días hacia atrás<ModernSelect value={String(account.maxAgeDays)} options={dayOptions(account.maxAgeDays)} disabled={busy !== null}
          onChange={value => change(account, { maxAgeDays: Number(value) }, 'Días hacia atrás guardados: cuentan para las conversaciones que aún no se han leído.')}/></label>
      </div>
      <div className="actions">
        <button type="button" className="button" disabled={busy !== null} onClick={() => change(account, { enabled: !account.enabled }, account.enabled ? 'Cuenta en pausa.' : 'Cuenta reanudada.')}>{account.enabled ? 'Pausar' : 'Reanudar'}</button>
      </div>
    </li>)}</ul> : <p className="muted">{state.hasKey ? 'Todavía no se ha leído ninguna cuenta: pulsa «Leer ahora».' : 'Sin clave no se pide nada a Zernio.'}</p>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
