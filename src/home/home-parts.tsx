import { useState, type ReactNode } from 'react';
import { cardDate, chatName, type Card } from '../inbox/inbox-cards';
import { kindLabels, sender } from '../inbox/inbox-labels';

export const day = (stamp: string) => new Date(stamp).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
export const hour = (stamp: string) => new Date(stamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** One block of the home panel: a title with its count, its content (or a calm line when there is nothing) and a
 * way to its section. `count` null means still reading. */
export function Block({ title, count, alert, wide, empty, onOpen, openLabel, children }: {
  title: string; count: number | null; alert?: string; wide?: boolean; empty: string; onOpen: () => void; openLabel: string; children?: ReactNode;
}) {
  return <section className={`home-block${wide ? ' wide' : ''}`} aria-label={title}>
    <header>
      <h3>{title}{count !== null && count > 0 && <span className="home-count"><span className="visually-hidden">: </span>{count}</span>}</h3>
      {alert && <span className="home-alert">{alert}</span>}
      <button type="button" className="home-open" onClick={onOpen}>{openLabel}<span aria-hidden="true"> ›</span></button>
    </header>
    {count === null ? <p className="home-empty">Leyendo…</p> : count === 0 ? <p className="home-empty">{empty}</p> : children}
  </section>;
}

/** The latest messages one card at a time, with ‹ › to go through them (round: the buttons never switch off under the
 * keyboard's focus). */
export function MailSlider<T,>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [at, setAt] = useState(0);
  const index = Math.min(at, items.length - 1);
  const move = (step: number) => setAt((index + step + items.length) % items.length);
  return <div className="home-slider">
    <button type="button" className="button" aria-label="Mensaje anterior" disabled={items.length < 2} onClick={() => move(-1)}>‹</button>
    <article className="home-slide" aria-live="polite">{render(items[index])}</article>
    <button type="button" className="button" aria-label="Mensaje siguiente" disabled={items.length < 2} onClick={() => move(1)}>›</button>
    <small className="home-pos">{index + 1} de {items.length}</small>
  </div>;
}

/** One received message of the home panel: a mail (sender, subject) or a WhatsApp conversation (with its badge, the
 * contact's name and never the number, and its kind), with the summary and what is asked, hidden in discreet mode. */
export function ReceivedSlide({ card, discreet }: { card: Card; discreet: boolean }) {
  const at = cardDate(card);
  const { summary, details } = card.item;
  const asks = details.asks ?? [];
  return <>
    <small className="home-meta">{card.source === 'chat' && <span className="home-badge">WhatsApp</span>}
      {card.source === 'mail' ? sender(card.item) : chatName(card.item)} · {day(at)} {hour(at)}</small>
    <strong>{card.source === 'mail' ? card.item.subject || 'Sin asunto' : kindLabels[card.item.kind]}</strong>
    {summary && !discreet && <p className="home-clamp">{summary}</p>}
    {asks.length > 0 && !discreet && <small className="home-ask">Pide: {asks.slice(0, 2).join(' · ')}</small>}
  </>;
}
