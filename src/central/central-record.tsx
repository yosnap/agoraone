import type { ReactNode } from 'react';

// The layout of a record of Central (client, project, server, quote): the whole width of the section, a head with
// the name, its badges and its actions on the right, and its parts in blocks that sit side by side when they fit.

export function RecordLayout({ titleId, title, subtitle, badges, actions, children }: {
  titleId: string; title: ReactNode; subtitle?: ReactNode; badges?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return <article className="central-record" aria-labelledby={titleId}>
    <header className="central-record-head">
      <div className="central-record-title"><h2 id={titleId}>{title}</h2>{subtitle && <small className="muted">{subtitle}</small>}</div>
      <div className="central-record-tools">{badges && <span className="central-chips">{badges}</span>}{actions}</div>
    </header>
    <div className="central-record-body">{children}</div>
  </article>;
}

/** A part of a record; `wide` takes the whole row (tables), `actions` go on the right of its title. */
export function Block({ title, wide = false, actions, children }: { title: string; wide?: boolean; actions?: ReactNode; children: ReactNode }) {
  return <section className={`central-block${wide ? ' wide' : ''}`} aria-label={title}>
    <div className="central-block-head"><h3>{title}</h3>{actions && <div className="actions central-actions">{actions}</div>}</div>
    {children}
  </section>;
}

/** Name and value pairs, in as many columns as fit. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="central-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
