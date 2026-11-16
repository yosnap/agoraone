import { useRef, useState } from 'react';
import { getAgenda, getAlerts, getCentral, getDoctor, getInbox, getReceipts, type Agenda, type AlertsView, type CentralState, type DoctorPiece, type InboxItem, type Receipt } from '../api/core';
import type { Section } from '../shell/shell-state';
import { moduleOn, useModules } from '../shell/modules';
import { doneButOpen, invoicesToFile, latestMail, serversByTrouble, systemNotes, upcoming } from './home-data';
import { Block, MailSlider } from './home-parts';
import './home.css';

type Data = {
  pending: InboxItem[] | null; done: InboxItem[] | null; mailProblem: string | null; agenda: Agenda | null; receipts: Receipt[] | null;
  alerts: AlertsView | null; central: CentralState | null; pieces: DoctorPiece[];
};
const empty: Data = { pending: null, done: null, mailProblem: null, agenda: null, receipts: null, alerts: null, central: null, pieces: [] };
const day = (stamp: string) => new Date(stamp).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const hour = (stamp: string) => new Date(stamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const sender = (item: InboxItem) => item.from.name || item.from.address || 'Remitente desconocido';
const SERVER_LABEL: Record<string, string> = { red: 'caído', amber: 'con avisos', green: 'bien', grey: 'sin datos' };

/** The home panel (1.7): blocks with what needs the user now, read from what AgoraOne already has (mail, agenda,
 * fiscal, Central, alerts, the doctor). Read-only and real; a part that cannot be read does not show, and discreet
 * mode leaves out what is not normal. Each block leads to its section; Watson stays at the right to ask. */
export function HomeBlocks({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [data, setData] = useState<Data>(empty);
  const [round, setRound] = useState(0);
  const asked = useRef<string | null>(null);
  const modules = useModules();
  const key = `${discreet}-${round}`;
  if (asked.current !== key) {
    asked.current = key;
    const put = (part: Partial<Data>) => setData(current => ({ ...current, ...part }));
    void getInbox('pending').then(r => put({ pending: r.items, mailProblem: r.problem })).catch(() => put({ pending: [] }));
    void getInbox('done').then(r => put({ done: r.items })).catch(() => put({ done: [] }));
    void getAgenda('semana').then(agenda => put({ agenda })).catch(() => put({ agenda: { events: [], reminders: [], overlaps: [], problem: 'No se pudo leer la agenda.' } }));
    void getReceipts().then(r => put({ receipts: r.receipts })).catch(() => put({ receipts: [] }));
    void getAlerts().then(alerts => put({ alerts })).catch(() => put({ alerts: { alerts: [], morning: null, problems: ['No se pudieron leer los avisos.'], callsProblem: null } as unknown as AlertsView }));
    void getCentral().then(central => put({ central })).catch(() => undefined);
    void getDoctor().then(r => put({ pieces: r.pieces })).catch(() => undefined);
  }
  const mailOn = moduleOn(modules, 'correo'), agendaOn = moduleOn(modules, 'agenda'), fiscalOn = moduleOn(modules, 'fiscal'), jobsOn = moduleOn(modules, 'trabajos');
  const mails = latestMail(data.pending ?? [], discreet);
  const events = upcoming(data.agenda?.events ?? []);
  const reminders = data.agenda?.reminders ?? [];
  const toFile = invoicesToFile(data.pending ?? [], data.receipts ?? [], discreet);
  const open = doneButOpen(data.done ?? [], discreet);
  const { servers, down } = serversByTrouble(data.central?.snapshot?.servers ?? []);
  const notes = systemNotes(data.alerts?.alerts ?? [], [mailOn ? data.mailProblem : null, agendaOn ? data.agenda?.problem : null, jobsOn ? data.central?.problem : null, ...(data.alerts?.problems ?? [])], data.pieces);
  return <div className="home" aria-label="Panel de inicio">
    <div className="home-head">
      <h2>Para ti ahora</h2>
      <button type="button" className="button" onClick={() => setRound(value => value + 1)}>Actualizar</button>
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
          <span>{event.title}{event.location && <small> · {event.location}</small>}</span>
        </li>)}</ul>}
      </Block>}
      {agendaOn && <Block title="Recordatorios" count={data.agenda === null ? null : reminders.length} onOpen={() => onOpen('agenda')} openLabel="Abrir la agenda"
        empty="No tienes recordatorios pendientes.">
        {reminders.length > 0 && <ul className="home-list">{reminders.slice(0, 6).map(reminder => <li key={reminder.id}>
          <span className="home-when">{reminder.due ? day(reminder.due) : 'sin fecha'}</span><span>{reminder.title}</span>
        </li>)}</ul>}
      </Block>}
      {fiscalOn && <Block title="Facturas por añadir" count={data.pending === null || data.receipts === null ? null : toFile.mails.length + toFile.receipts.length}
        onOpen={() => onOpen(toFile.receipts.length && !toFile.mails.length ? 'fiscal' : 'inbox')} openLabel={toFile.receipts.length && !toFile.mails.length ? 'Abrir Fiscal' : 'Abrir la Bandeja'}
        empty="No hay facturas ni recibos por archivar.">
        {toFile.mails.length + toFile.receipts.length > 0 && <ul className="home-list">
          {toFile.mails.slice(0, 4).map(item => <li key={`m${item.id}`}><span className="home-when">correo</span><span>{sender(item)}{item.details.amounts?.[0] ? ` · ${item.details.amounts[0]}` : ''}</span></li>)}
          {toFile.receipts.slice(0, 3).map(receipt => <li key={`r${receipt.id}`}><span className="home-when">recibo</span><span>{receipt.fields.supplier || receipt.name || 'Recibo sin leer'}{receipt.fields.total ? ` · ${receipt.fields.total}` : ''}</span></li>)}
        </ul>}
      </Block>}
      {mailOn && <Block title="Archivados con algo pendiente" count={data.done === null ? null : open.length} onOpen={() => onOpen('inbox')} openLabel="Abrir la Bandeja"
        empty="Lo que has dado por hecho no deja peticiones ni plazos abiertos.">
        {open.length > 0 && <ul className="home-list">{open.slice(0, 4).map(item => <li key={item.id}>
          <span className="home-when">{day(item.sentAt)}</span>
          <span>{item.subject || sender(item)}<small className="home-clamp">{[...(item.details.asks ?? []), ...(item.details.dates ?? [])].slice(0, 2).join(' · ')}</small></span>
        </li>)}</ul>}
      </Block>}
      <Block title="Avisos del sistema" count={data.alerts === null ? null : notes.length} onOpen={() => onOpen('settings')} openLabel="Abrir Ajustes" empty="Todo en orden.">
        {notes.length > 0 && <ul className="home-list">{notes.slice(0, 6).map(note => <li key={note.key} className={note.tone === 'warn' ? 'warn' : ''}>
          <span>{note.text}{note.detail && <small> · {note.detail}</small>}</span>
        </li>)}</ul>}
      </Block>
      {jobsOn && data.central?.configured && <Block title="Servidores" count={servers.length} alert={down > 0 ? `${down} con problemas` : undefined} onOpen={() => onOpen('jobs')} openLabel="Abrir Trabajos"
        empty="Central no tiene servidores.">
        {servers.length > 0 && <ul className="home-list">{servers.slice(0, 6).map(server => <li key={server.name} className={server.status === 'red' ? 'warn' : ''}>
          <span className={`home-dot ${server.status ?? 'grey'}`} aria-hidden="true"/>
          <span>{server.name}<small> · {SERVER_LABEL[server.status ?? 'grey'] ?? server.status}{server.provider ? ` · ${server.provider}` : ''}</small></span>
        </li>)}</ul>}
      </Block>}
    </div>
  </div>;
}
