// The review of a confirmed change to a connected service (Central, CRMDev…), only presentation: the exact change
// field by field (what the service has now and what it will have), its warnings and notes, and the buttons to save it
// or not; after a conflict, what the service has now; and for a creation the service already has, the existing one.
// Every value is React text: never HTML.

export type ReviewRow = { field: string; label: string; before: string | null; after: string | null; emptied: boolean };
/** What the service has now of a record, after a conflict. */
export type ReviewCurrent = { field: string; label: string; value: string | null };
export type ReviewState = {
  preview: { title: string; rows: ReviewRow[]; notes: string[]; warnings: string[] } | null;
  busy: boolean;
  error: string;
  conflict: { message: string; current: ReviewCurrent[] } | null;
  /** A creation the service already has: `id` of the existing one, when known. */
  exists: { message: string; id: string | null } | null;
  send: () => Promise<void>;
};

const shown = (value: string | null) => (value === null || value === '' ? <em className="muted">vacío</em> : value);

/** `where` names the service in the headers and in «Guardar en …»; `onLink` (with `linkLabel`) acts on the existing
 * record of a creation the service already has. */
export function ChangeReview({ change, where, onCancel, onReview, onLink, linkLabel = 'Ver el existente' }: {
  change: ReviewState; where: string; onCancel: () => void; onReview: () => void; onLink?: (id: string) => void; linkLabel?: string;
}) {
  if (change.exists) {
    const { id, message } = change.exists;
    return <div className="central-change" role="alert">
      <p className="notice">{message}</p>
      <div className="actions central-actions">
        <button type="button" className="button" onClick={onCancel}>Cerrar</button>
        {onLink && id && <button type="button" className="button primary" onClick={() => onLink(id)}>{linkLabel}</button>}
      </div>
    </div>;
  }
  if (change.conflict) {
    return <div className="central-change" role="alert">
      <p className="notice">{change.conflict.message}</p>
      {change.conflict.current.length > 0 && <table className="data-table central-table">
        <thead><tr><th>Campo</th><th>Lo que hay ahora en {where}</th></tr></thead>
        <tbody>{change.conflict.current.map(row => <tr key={row.field}><td>{row.label}</td><td className="central-text">{shown(row.value)}</td></tr>)}</tbody>
      </table>}
      <div className="actions central-actions">
        <button type="button" className="button" onClick={onCancel}>Cerrar</button>
        <button type="button" className="button primary" onClick={onReview}>Volver a revisar</button>
      </div>
    </div>;
  }
  const preview = change.preview;
  if (!preview) return change.error ? <p className="error" role="alert">{change.error}</p> : null;
  return <div className="central-change" aria-label={`Cambio que se hará en ${where}`}>
    <strong>{preview.title}</strong>
    <table className="data-table central-table">
      <thead><tr><th>Campo</th><th>Ahora en {where}</th><th>Después</th></tr></thead>
      <tbody>{preview.rows.map(row => <tr key={row.field} className={row.emptied ? 'central-emptied' : undefined}>
        <td>{row.label}</td><td className="central-text">{shown(row.before)}</td><td className="central-text"><strong>{shown(row.after)}</strong></td>
      </tr>)}</tbody>
    </table>
    {preview.warnings.map(text => <p key={text} className="notice">{text}</p>)}
    {preview.notes.map(text => <p key={text} className="muted">{text}</p>)}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <button type="button" className="button" disabled={change.busy} onClick={onCancel}>Cancelar</button>
      <button type="button" className="button primary" disabled={change.busy} onClick={() => void change.send()}>{change.busy ? 'Guardando…' : `Guardar en ${where}`}</button>
    </div>
  </div>;
}
