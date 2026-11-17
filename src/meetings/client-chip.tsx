import type { CSSProperties } from 'react';
export { clientHue } from './client-hue';

export function ClientChip({ client, project, hue }: { client: string; project?: string | null; hue: number | null }) {
  return <span className={`client-chip${hue === null ? ' plain' : ''}`} style={hue === null ? undefined : { '--client-hue': hue } as CSSProperties}>
    <span className="client-dot" aria-hidden="true"/>{client}{project && <span className="client-project"> · {project}</span>}
  </span>;
}
