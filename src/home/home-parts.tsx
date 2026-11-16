import { useState, type ReactNode } from 'react';

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

/** The latest mail one card at a time, with ‹ › to go through them (round: the buttons never switch off under the
 * keyboard's focus). */
export function MailSlider<T extends { id: number }>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [at, setAt] = useState(0);
  const index = Math.min(at, items.length - 1);
  const move = (step: number) => setAt((index + step + items.length) % items.length);
  return <div className="home-slider">
    <button type="button" className="button" aria-label="Correo anterior" disabled={items.length < 2} onClick={() => move(-1)}>‹</button>
    <article className="home-slide" aria-live="polite">{render(items[index])}</article>
    <button type="button" className="button" aria-label="Correo siguiente" disabled={items.length < 2} onClick={() => move(1)}>›</button>
    <small className="home-pos">{index + 1} de {items.length}</small>
  </div>;
}
