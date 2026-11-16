import { useRef, useState } from 'react';
import { getAgenda, getAlerts, getCentral, getDoctor, getInbox, getReceipts, type Agenda, type AlertsView, type CentralState, type DoctorPiece, type InboxItem, type Receipt } from '../api/core';
import type { Section } from '../shell/shell-state';
import { moduleOn, useModules } from '../shell/modules';
import { doneButOpen, invoicesToFile, latestMail, openDates, serversByTrouble, systemNotes, upcoming } from './home-data';
import { Block, MailSlider } from './home-parts';
import './home.css';

type Data = {
  pending: InboxItem[] | null; done: InboxItem[] | null; mailProblem: string | null; agenda: Agenda | null; receipts: Receipt[] | null;
  alerts: AlertsView | null; alertsProblem: string | null; central: CentralState | null; pieces: DoctorPiece[];
};
const empty: Data = { pending: null, done: null, mailProblem: null, agenda: null, receipts: null, alerts: null, alertsProblem: null, central: null, pieces: [] };
// What was read last, kept a minute: going to the graph and back does not read everything again (reading receipts
// also imports the new ones, as opening Fiscal does).
let kept: { data: Data; at: number } | null = null;
const FRESH = 60_000;
const HIDDEN = '•••';
// The latest reading: one counter for the screen, so a render React repeats cannot split it in two.
let latest = 0;
const day = (stamp: string) => new Date(stamp).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const hour = (stamp: string) => new Date(stamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const sender = (item: InboxItem) => item.from.name || item.from.address || 'Remitente desconocido';
const SERVER_LABEL: Record<string, string> = { red: 'caído', amber: 'con avisos', green: 'bien', grey: 'sin datos' };

/** The home panel (1.7): blocks with what needs the user now, read from what AgoraOne already has (mail, agenda,
 * fiscal, Central, alerts, the doctor). Read-only and real; a part that cannot be read does not show, and discreet
 * mode leaves out what is not normal. Each block leads to its section; Watson stays at the right to ask. */
export function HomeBlocks({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [data, setData] = useState<Data>(() => kept?.data ?? empty);
  const [waiting, setWaiting] = useState(0);
  const asked = useRef(false);
  const modules = useModules();
  const mailOn = moduleOn(modules, 'correo'), agendaOn = moduleOn(modules, 'agenda'), fiscalOn = moduleOn(modules, 'fiscal'), jobsOn = moduleOn(modules, 'trabajos');
  // Each reading is a round: an answer from an older round (a slow one, after «Actualizar») never overwrites a newer one.
  const read = () => {
    const mine = ++latest;
    const jobs: Promise<unknown>[] = [];
    const put = (part: Partial<Data>) => { if (mine === latest) setData(current => { const next = { ...current, ...part }; kept = { data: next, at: Date.now() }; return next; }); };
    const run = <T,>(ask: () => Promise<T>, done: (value: T) => Partial<Data>, failed: Partial<Data>) => jobs.push(ask().then(value => put(done(value))).catch(() => put(failed)));
    run(() => getInbox('pending'), r => ({ pending: r.items, mailProblem: r.problem }), { pending: [], mailProblem: 'No se pudo leer la Bandeja.' });
    run(() => getInbox('done'), r => ({ done: r.items }), { done: [] });
    run(() => getAgenda('semana'), agenda => ({ agenda }), { agenda: { events: [], reminders: [], overlaps: [], problem: 'No se pudo leer la agenda.' } });
    if (fiscalOn) run(getReceipts, r => ({ receipts: r.receipts }), { receipts: [] });
    run(getAlerts, alerts => ({ alerts, alertsProblem: null }), { alertsProblem: 'No se pudieron leer los avisos.' });
    run(getCentral, central => ({ central }), {});
    run(getDoctor, r => ({ pieces: r.pieces }), {});
    void Promise.resolve().then(() => setWaiting(mine));
    void Promise.allSettled(jobs).then(() => setWaiting(current => current === mine ? 0 : current));
  };
  if (!asked.current) { asked.current = true; if (!kept || Date.now() - kept.at > FRESH) read(); }
  const hide = (text: string) => discreet ? HIDDEN : text;
  const mails = latestMail(data.pending ?? [], discreet);
  const events = upcoming(data.agenda?.events ?? []);
  const reminders = data.agenda?.reminders ?? [];
  const toFile = invoicesToFile(mailOn ? data.pending ?? [] : [], data.receipts ?? [], discreet);
  const toFileTotal = (mailOn ? toFile.mails.length : 0) + toFile.receipts.length;
  const fileHere = toFile.mails.length && mailOn ? 'inbox' : 'fiscal';
  const open = doneButOpen(data.done ?? [], discreet);
  const { servers, down } = serversByTrouble(data.central?.snapshot?.servers ?? []);
  const readingProblems = mailOn || agendaOn ? data.alerts?.problems ?? [] : [];
  const notes = systemNotes(data.alerts?.alerts ?? [], [mailOn ? data.mailProblem : null, agendaOn ? data.agenda?.problem : null, jobsOn ? data.central?.problem : null,
    data.alertsProblem, ...readingProblems], data.pieces, name => moduleOn(modules, name), discreet);
  return <div className="home" role="region" aria-label="Panel de inicio">
    <div className="home-head">
      <h2>Para ti ahora</h2>
      <button type="button" className="button" disabled={waiting > 0} onClick={read}>{waiting > 0 ? 'Actualizando…' : 'Actualizar'}</button>
    </div>
    <div className="home-grid">
      {mailOn && <Block title="Correo recibido" count={data.pending === null ? null : mails.length} wide onOpen={() => onOpen('inbox')} openLabel="Abrir la Bandeja"
        empty="No hay correos esperando.">
        {mails.length > 0 && <MailSlider items={mails} render={item => <>
          <small className="home-meta">{sender(item)} · {day(item.sentAt)} {hour(item.sentAt)}</small>
          <strong>{item.subject || 'Sin asunto'}</strong>
          {item.summary && <p className="home-clamp">{item.summary}</p>}
          {(item.details.asks?.length ?? 0) > 0 && <small className="home-ask">Pide: {item.details.asks!.slice(0, 2).join(' · ')}</small>}
        </>}/>}
      </Block>}
      {agendaOn && <Block title="Próximas reuniones" count={data.agenda === null ? null : events.length} onOpen={() => onOpen('agenda')} openLabel="Abrir la agenda"
        empty="Nada más esta semana.">
        {events.length > 0 && <ul className="home-list">{events.map(event => <li key={event.id} className={event.soon ? 'soon' : ''}>
          <span className="home-when">{event.allDay ? day(event.start) : `${day(event.start)} ${hour(event.start)}`}</span>
          <span>{hide(event.title)}{event.location && !discreet && <small> · {event.location}</small>}</span>
        </li>)}</ul>}
      </Block>}
      {agendaOn && <Block title="Recordatorios" count={data.agenda === null ? null : reminders.length} onOpen={() => onOpen('agenda')} openLabel="Abrir la agenda"
        empty="No tienes recordatorios pendientes.">
        {reminders.length > 0 && <ul className="home-list">{reminders.slice(0, 6).map(reminder => <li key={reminder.id}>
          <span className="home-when">{reminder.due ? day(reminder.due) : 'sin fecha'}</span><span>{hide(reminder.title)}</span>
        </li>)}</ul>}
      </Block>}
      {fiscalOn && <Block title="Facturas por añadir" count={(mailOn && data.pending === null) || data.receipts === null ? null : toFileTotal}
        onOpen={() => onOpen(fileHere)} openLabel={fileHere === 'inbox' ? 'Abrir la Bandeja' : 'Abrir Fiscal'}
        empty="No hay facturas ni recibos por archivar.">
        {toFileTotal > 0 && <ul className="home-list">
          {toFile.mails.slice(0, 4).map(item => <li key={`m${item.id}`}><span className="home-when">correo</span><span>{sender(item)}{item.details.amounts?.[0] ? ` · ${hide(item.details.amounts[0])}` : ''}</span></li>)}
          {toFile.receipts.slice(0, 3).map(receipt => <li key={`r${receipt.id}`}><span className="home-when">recibo</span><span>{hide(receipt.fields.supplier || receipt.name || 'Recibo sin leer')}{receipt.fields.total ? ` · ${hide(receipt.fields.total)}` : ''}</span></li>)}
        </ul>}
      </Block>}
      {mailOn && <Block title="Archivados con algo pendiente" count={data.done === null ? null : open.length} onOpen={() => onOpen('inbox')} openLabel="Abrir la Bandeja"
        empty="Lo que has dado por hecho no deja peticiones ni plazos abiertos.">
        {open.length > 0 && <ul className="home-list">{open.slice(0, 4).map(item => <li key={item.id}>
          <span className="home-when">{day(item.sentAt)}</span>
          <span>{item.subject || sender(item)}<small className="home-clamp">{[...(item.details.asks ?? []), ...openDates(item).map(date => `plazo ${day(date)}`)].slice(0, 2).join(' · ')}</small></span>
        </li>)}</ul>}
      </Block>}
      <Block title="Avisos del sistema" count={data.alerts === null && data.alertsProblem === null ? null : notes.length} onOpen={() => onOpen('settings')} openLabel="Abrir Ajustes" empty="Todo en orden.">
        {notes.length > 0 && <ul className="home-list">{notes.slice(0, 6).map(note => <li key={note.key} className={note.tone === 'warn' ? 'warn' : ''}>
          <span>{note.text}{note.detail && <small> · {note.detail}</small>}</span>
        </li>)}</ul>}
      </Block>
      {jobsOn && data.central?.configured && <Block title="Servidores" count={servers.length} alert={down > 0 ? `${down} con problemas` : undefined} onOpen={() => onOpen('jobs')} openLabel="Abrir Trabajos"
        empty="Central no tiene servidores.">
        {servers.length > 0 && <ul className="home-list">{servers.slice(0, 6).map((server, index) => <li key={`${server.name}-${index}`} className={server.status === 'red' ? 'warn' : ''}>
          <span className={`home-dot ${server.status ?? 'grey'}`} aria-hidden="true"/>
          <span>{server.name}<small> · {SERVER_LABEL[server.status ?? 'grey'] ?? server.status}{server.provider ? ` · ${server.provider}` : ''}</small></span>
        </li>)}</ul>}
      </Block>}
    </div>
  </div>;
}
