import { useMemo, useState } from 'react';
import { appVersion } from './app-version';
import { releases } from './changelog-data';
import type { ChangeKind, Release } from './changelog-types';
import { InlineText } from './inline-text';
import './about.css';

export const kindLabels: Record<ChangeKind, { label: string; icon: string }> = {
  feature: { label: 'Novedad', icon: '+' },
  improvement: { label: 'Mejora', icon: '↑' },
  fix: { label: 'Arreglo', icon: '✓' },
  security: { label: 'Seguridad', icon: '◆' },
  change: { label: 'Cambio', icon: '↻' },
};
const kinds = Object.keys(kindLabels) as ChangeKind[];

/** The version a build belongs to: «1.10.0-alpha.2» is part of 1.10.0. */
export const baseVersion = (version: string) => version.split('-')[0];

const longDate = (iso: string) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : 'En preparación';

function count(release: Release) {
  const by = new Map<ChangeKind, number>();
  for (const change of release.changes) by.set(change.kind, (by.get(change.kind) ?? 0) + 1);
  return kinds.filter(kind => by.has(kind)).map(kind => [kind, by.get(kind)!] as const);
}

/** Every published version, newest first, each one an accordion with its changes by kind (Ajustes › Novedades). */
export function ChangelogCard() {
  const [only, setOnly] = useState<ChangeKind | null>(null);
  const current = baseVersion(appVersion);
  const shown = useMemo(() => releases.map(release => ({ release, changes: only ? release.changes.filter(c => c.kind === only) : release.changes }))
    .filter(entry => entry.changes.length), [only]);
  return <article className="card about-card" aria-labelledby="settings-changelog">
    <div className="card-head"><h2 id="settings-changelog">Novedades</h2><span className="chip">Estás en la v{appVersion}</span></div>
    <p>Todas las versiones de AgoraOne, de la más reciente a la primera. Abre una para ver qué trajo; los cambios con más detalle se despliegan.</p>
    <div className="about-filter" role="group" aria-label="Filtrar por tipo de cambio">
      <button type="button" aria-pressed={only === null} onClick={() => setOnly(null)}>Todos</button>
      {kinds.map(kind => <button key={kind} type="button" aria-pressed={only === kind} onClick={() => setOnly(only === kind ? null : kind)}>
        <span aria-hidden="true">{kindLabels[kind].icon}</span> {kindLabels[kind].label}</button>)}
    </div>
    <div className="about-list">
      {shown.map(({ release, changes }) => <details key={release.version} className="about-release" open={release.version === current}>
        <summary>
          <span className="about-version">v{release.version}</span>
          <span className="about-title">{release.title || 'Sin título'}</span>
          {release.version === current && <span className="chip good">Tu versión</span>}
          <span className="about-counts">{count({ ...release, changes }).map(([kind, n]) => <span key={kind} className={`about-kind ${kind}`} title={kindLabels[kind].label}>
            <span aria-hidden="true">{kindLabels[kind].icon}</span> {n}<span className="visually-hidden"> {kindLabels[kind].label}</span></span>)}</span>
          <time className="about-date" dateTime={release.date || undefined}>{longDate(release.date)}</time>
        </summary>
        {release.summary && <p className="about-summary"><InlineText text={release.summary}/></p>}
        <ul className="about-changes">
          {changes.map((change, index) => <li key={index}>
            <span className={`about-kind ${change.kind}`}><span aria-hidden="true">{kindLabels[change.kind].icon}</span> {kindLabels[change.kind].label}</span>
            {change.detail
              ? <details className="about-change"><summary><InlineText text={change.title}/>{change.area && <span className="about-area">{change.area}</span>}</summary><p><InlineText text={change.detail}/></p></details>
              : <span className="about-change-title"><InlineText text={change.title}/>{change.area && <span className="about-area">{change.area}</span>}</span>}
          </li>)}
        </ul>
      </details>)}
    </div>
  </article>;
}
