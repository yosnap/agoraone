import { useRef, useState } from 'react';
import { getOrcaBots, type BotErrandKind, type BotErrandPreview, type OrcaBots } from '../api/orca-bots';
import { ModernSelect } from '../ui/modern-select';

const kinds: { value: BotErrandKind; label: string }[] = [{ value: 'handoff', label: 'Encargar' }, { value: 'question', label: 'Preguntar' }];

/** The bot's part of the Orca card: which bot (only those not paused) and whether it takes the job or answers a
 * question. Without a ready mailbox it says where to create it, and nothing can be previewed. */
export function BotErrandFields({ bot, onBot, kind, onKind, onReady }: { bot: string; onBot: (id: string) => void; kind: BotErrandKind;
  onKind: (kind: BotErrandKind) => void; onReady: (ready: boolean) => void }) {
  const [data, setData] = useState<OrcaBots | null>(null);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void getOrcaBots().then(found => {
      setData(found);
      const usable = found.bots.filter(b => !b.paused);
      onReady(found.mailbox?.state === 'ready' && usable.length > 0);
      if (!bot && usable[0]) onBot(usable[0].id);
    }).catch(() => setData({ on: true, bots: [], mailbox: null, problem: 'No se pudo leer Orca.' }));
  }
  if (!data) return <p className="muted">Leyendo tus bots de Orca…</p>;
  const usable = data.bots.filter(b => !b.paused);
  if (data.problem) return <p className="notice">{data.problem}</p>;
  if (data.mailbox?.state !== 'ready') return <p className="notice">{data.mailbox?.problem ?? 'Falta el buzón de AgoraOne en Orca'}: créalo en Agentes › Bots de Orca.</p>;
  if (!usable.length) return <p className="notice">No tienes bots activos en Orca: créalos desde su barra lateral «Bots».</p>;
  return <div className="orca-grid">
    <label className="field">Bot<ModernSelect value={bot} onChange={onBot}
      options={usable.map(b => ({ value: b.id, label: b.purpose ? `${b.name} · ${b.purpose}` : b.name }))}/></label>
    <div className="field">Qué le pides<div className="segmented" role="group" aria-label="Qué le pides">{kinds.map(k =>
      <button type="button" key={k.value} aria-pressed={kind === k.value} onClick={() => onKind(k.value)}>{k.label}</button>)}</div></div>
  </div>;
}

/** Exactly what the bot will receive, before «Enviar a <bot>». */
export function BotErrandFacts({ preview }: { preview: BotErrandPreview }) {
  return <>
    <dl className="orca-facts">
      <dt>Bot</dt><dd>{preview.bot.name}{preview.bot.agent ? <span className="muted"> · {preview.bot.agent}</span> : null}</dd>
      <dt>Qué le pides</dt><dd>{preview.kindLabel}{preview.kind === 'handoff' ? ' (se queda con el trabajo)' : ' (te responde)'}</dd>
      <dt>Chat</dt><dd>Uno nuevo del bot, titulado «{preview.subject}»; nunca su chat principal</dd>
      <dt>Repositorio</dt><dd>{preview.repo} <span className="muted">· en Orca como «{preview.orcaName}»</span></dd>
      <dt>Proyecto</dt><dd>{preview.project} <span className="muted">· {preview.client}</span></dd>
      {preview.source && <><dt>Origen</dt><dd>{preview.source.label}</dd></>}
    </dl>
    <span className="muted">Texto exacto que recibirá el bot:</span>
    <pre className="orca-prompt">{preview.body}</pre>
  </>;
}
