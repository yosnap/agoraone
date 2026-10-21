export type Crumb = { label: string; onClick?: () => void };

/** Where the user is: city, interior, open panel and tab. Every level but the last goes back to it. */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return <nav className="breadcrumbs" aria-label="Estás en">
    <ol>{crumbs.map((crumb, index) => {
      const last = index === crumbs.length - 1;
      return <li key={index}>{last || !crumb.onClick ? <span aria-current={last ? 'location' : undefined}>{crumb.label}</span> : <button type="button" onClick={crumb.onClick}>{crumb.label}</button>}</li>;
    })}</ol>
  </nav>;
}
