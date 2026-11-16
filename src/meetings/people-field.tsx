import { useRef, useState } from 'react';
import { askContactsAccess, findContacts, type MeetingPerson, type ContactMatch } from '../api/core';

/** «Ana, Luis Pérez» → two people with no address. */
export const typedPeople = (text: string): MeetingPerson[] => text.split(/[,;\n]/).map(name => name.trim()).filter(Boolean).map(name => ({ name, email: null }));
export const personLabel = (person: MeetingPerson) => person.email ? `${person.name} <${person.email}>` : person.name;

/** «Con quién»: people picked from the Mac's Contacts (with their address) as tags, or names typed and
 * separated by commas for those who are not there. The list of contacts never leaves this machine. */
export function PeopleField({ value, onChange, onTyping }: { value: MeetingPerson[]; onChange: (next: MeetingPerson[]) => void; onTyping?: (text: string) => void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<ContactMatch[]>([]);
  const [active, setActive] = useState(-1);
  const [access, setAccess] = useState<string | null>(null);
  const timer = useRef(0);
  const asked = useRef(0);
  // Any answer still on its way is for an older text: it is dropped, so Enter never picks someone else.
  const cancel = () => { window.clearTimeout(timer.current); asked.current++; setFound([]); setActive(-1); };
  const write = (next: string) => { setText(next); onTyping?.(next); };
  const add = (people: MeetingPerson[]) => {
    cancel();
    const keys = new Set(value.map(p => (p.email ?? p.name).toLowerCase()));
    onChange([...value, ...people.filter(p => !keys.has((p.email ?? p.name).toLowerCase()))]);
    write('');
  };
  const search = (query: string) => {
    cancel();
    if (query.trim().length < 2) return;
    const mine = asked.current;
    timer.current = window.setTimeout(() => void findContacts(query.trim()).then(result => {
      if (mine !== asked.current) return;
      setAccess(result.status); setFound(result.contacts); setActive(result.contacts.length ? 0 : -1);
    }).catch(() => { if (mine === asked.current) setFound([]); }), 200);
  };
  const type = (next: string) => {
    if (/[,;]/.test(next)) { add(typedPeople(next)); return; }
    write(next); search(next);
  };
  const pick = (contact: ContactMatch) => add([{ name: contact.name, email: contact.email }]);
  const allow = async () => { try { setAccess((await askContactsAccess()).contacts); if (text) search(text); } catch { setAccess('denied'); } };
  return <div className="field people-field">
    <span>Con quién</span>
    <div className="people-box">
      {value.map((person, n) => <span key={n} className="people-tag" title={personLabel(person)}>
        {person.name}{person.email && <small> · {person.email}</small>}
        <button type="button" aria-label={`Quitar a ${person.name}`} onClick={() => onChange(value.filter((_, i) => i !== n))}>✕</button>
      </span>)}
      <input value={text} maxLength={200} placeholder={value.length ? '' : 'Busca en tus contactos o escribe nombres separados por comas'}
        role="combobox" aria-expanded={found.length > 0} aria-autocomplete="list" aria-label="Con quién"
        onChange={event => type(event.target.value)}
        onBlur={() => { if (text.trim()) add(typedPeople(text)); else cancel(); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && found.length) { event.preventDefault(); setActive(i => Math.min(found.length - 1, i + 1)); }
          else if (event.key === 'ArrowUp' && found.length) { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); if (found[active]) pick(found[active]); else if (text.trim()) add(typedPeople(text)); }
          else if (event.key === 'Escape') cancel();
          else if (event.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}/>
    </div>
    {found.length > 0 && <div className="people-list" role="listbox" aria-label="Contactos">
      {found.map((contact, n) => <button type="button" key={n} role="option" aria-selected={n === active}
        className={n === active ? 'active' : ''} onMouseDown={event => { event.preventDefault(); pick(contact); }}>
        <strong>{contact.name}</strong>{contact.org && <small> · {contact.org}</small>}{contact.email && <small className="muted"> · {contact.email}</small>}
      </button>)}
    </div>}
    {access && access !== 'granted' && <small className="muted">
      {access === 'unavailable' ? 'Los contactos solo se leen en macOS: escribe los nombres separados por comas.'
        : <>{access === 'undetermined' ? 'AgoraOne todavía no tiene permiso para leer tus contactos.' : 'AgoraOne no puede leer tus contactos.'} <button type="button" className="button" onClick={() => void allow()}>Darle permiso</button> (o en Ajustes del Sistema › Privacidad › Contactos).</>}
    </small>}
  </div>;
}
