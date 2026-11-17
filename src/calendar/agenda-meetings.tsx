import { useRef, useState } from 'react';
import { getMeetings, kindLabels, type Meeting } from '../api/core';
import { requestMeeting } from '../meetings/meeting-intent';
import { ymd } from './calendar-views';
import { hourMinute } from './event-form';

/** The meetings recorded in AgoraOne during the days shown, each opening its record in Reuniones. */
export function AgendaMeetings({ first, last, discreet, onOpen }: { first: Date; last: Date; discreet: boolean; onOpen: () => void }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getMeetings().then(found => setMeetings(found.meetings)).catch(() => setMeetings([])); }
  const shown = (meetings ?? []).filter(m => ymd(new Date(m.started_at)) >= ymd(first) && ymd(new Date(m.started_at)) <= ymd(last))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  if (!shown.length) return null;
  const open = (meeting: Meeting) => { requestMeeting({ open: meeting.id }); onOpen(); };
  return <>
    <h2>Reuniones grabadas</h2>
    <ul className="agenda-list">{shown.map(m => <li key={m.id}>
      <span className="agenda-time">{new Date(m.started_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} {hourMinute(m.started_at)}</span>
      <span className="agenda-what"><button type="button" className="agenda-open" onClick={() => open(m)}><span>{discreet ? '•••' : m.title}</span>
        <small className="muted"> · {kindLabels[m.kind]}{m.client && !discreet ? ` · ${m.client}` : ''}{m.status === 'recording' ? ' · grabando' : ''}</small></button></span>
    </li>)}</ul>
  </>;
}
