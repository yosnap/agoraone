import { useRef, useState } from 'react';
import { getDoctor, type DoctorPiece } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';

const labels: Record<DoctorPiece['state'], string> = { ok: 'Instalado', missing: 'Falta', optional: 'Opcional' };
const COMPATIBLE = new Set(['codex', 'gemini', 'opencode', 'cursor']);

function How({ how }: { how: DoctorPiece['how'] }) {
  if (how.kind === 'brew' || how.kind === 'command') return <code className="install-command">{how.command}</code>;
  if (how.kind === 'page' && how.url) return <a href={how.url} target="_blank" rel="noreferrer">Cómo conseguirlo</a>;
  if (how.kind === 'model') return <small className="muted">{how.model} · unos {Math.round((how.bytes ?? 0) / 1e9 * 10) / 10} GB</small>;
  return null;
}

function Group({ title, pieces }: { title: string; pieces: DoctorPiece[] }) {
  if (!pieces.length) return null;
  return <section className="install-group" aria-label={title}>
    <h3>{title}</h3>
    <ul className="install-list">{pieces.map(piece => <li key={piece.id} className={`install-row ${piece.state}`}>
      <span className={`status-badge ${piece.state === 'ok' ? 'good' : piece.state === 'missing' ? 'bad' : 'paused'}`}>{labels[piece.state]}</span>
      <div className="install-text">
        <strong>{piece.name}</strong>
        <small className="muted">{piece.modules.join(' · ')}</small>
        {piece.detail && <small>{piece.detail}</small>}
        {piece.state !== 'ok' && <How how={piece.how}/>}
      </div>
    </li>)}</ul>
  </section>;
}

/** «Qué tengo instalado» (1.6, C-01): what AgoraOne can use on this computer, which module needs each piece and
 * how to get what is missing. Looking changes nothing; installing comes with a confirmation per piece. */
export function InstallSettingsCard() {
  const [found, setFound] = useState<Awaited<ReturnType<typeof getDoctor>> | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => { setError(''); void getDoctor().then(setFound).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo comprobar.')); };
  if (!asked.current) { asked.current = true; load(); }
  const pieces = found?.pieces ?? [];
  return <article className="card" aria-labelledby="install-title">
    <div className="card-head"><h2 id="install-title">Qué tengo instalado</h2>
      {found && <span className={`status-badge ${found.missing ? 'bad' : 'good'}`}>{found.missing ? `Faltan ${found.missing}` : 'Todo listo'}</span>}</div>
    <p>Lo que AgoraOne puede usar en este equipo, para qué módulo sirve cada pieza y cómo conseguir lo que falta. Comprobarlo no cambia nada.</p>
    {!found && !error ? <Loading label="Comprobando lo instalado" lines={4}/> : found && <>
      <p className="muted">{found.summary} <button type="button" className="button" onClick={() => { setFound(null); load(); }}>Volver a comprobar</button></p>
      <Group title="Necesarias para algún módulo" pieces={pieces.filter(p => p.state !== 'optional' && !COMPATIBLE.has(p.id))}/>
      <Group title="Opcionales" pieces={pieces.filter(p => p.state === 'optional' && !COMPATIBLE.has(p.id))}/>
      <Group title="Compatibilidad (próximamente)" pieces={pieces.filter(p => COMPATIBLE.has(p.id))}/>
    </>}
    {error && <LoadError message={error}/>}
  </article>;
}
