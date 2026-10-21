import './load-state.css';

/** Placeholder bars while something is read; the label is what screen readers hear. */
export function Loading({ label, lines = 3 }: { label: string; lines?: number }) {
  return <div className="skeleton" role="status"><span className="visually-hidden">{label}</span>
    {Array.from({ length: lines }, (_, index) => <span key={index} className="skeleton-line" aria-hidden="true" style={{ width: `${92 - (index % 3) * 18}%` }}/>)}
  </div>;
}

/** A failed read, with the way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error load-error" role="alert"><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}>Reintentar</button>}</div>;
}
