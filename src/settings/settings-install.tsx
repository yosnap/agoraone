import { useRef, useState } from 'react';
import { getDoctor, getInstallJob, installPiece, type DoctorPiece, type InstallJob } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { showFirstRunAgain } from '../shell/first-run';

const labels: Record<DoctorPiece['state'], string> = { ok: 'Instalado', missing: 'Falta', optional: 'Opcional' };
const COMPATIBLE = new Set(['codex', 'gemini', 'opencode', 'cursor']);

function How({ how }: { how: DoctorPiece['how'] }) {
  if (how.kind === 'brew' || how.kind === 'command') return <code className="install-command">{how.command}</code>;
  if (how.kind === 'page' && how.url) return <a href={how.url} target="_blank" rel="noreferrer">Cómo conseguirlo</a>;
  if (how.kind === 'model') return <small className="muted">{how.model} · unos {Math.round((how.bytes ?? 0) / 1e9 * 10) / 10} GB</small>;
  return null;
}

/** Install one piece after a confirmation that shows exactly what will run (or how much is downloaded). */
function InstallButton({ piece, busy, onStart }: { piece: DoctorPiece; busy: boolean; onStart: (id: string) => void }) {
  const [asking, setAsking] = useState(false);
  if (piece.how.kind !== 'brew' && piece.how.kind !== 'model') return null;
  const what = piece.how.kind === 'brew' ? `Se ejecutará «${piece.how.command}» con Homebrew.` : `Se descargarán unos ${Math.round((piece.how.bytes ?? 0) / 1e8) / 10} GB de Hugging Face a ~/.cache/whisper.`;
  return asking ? <span className="meeting-confirm" role="group" aria-label="Confirmar la instalación">
      <span>{what}</span>
      <button type="button" className="button primary" disabled={busy} onClick={() => { setAsking(false); onStart(piece.id); }}>Instalar</button>
      <button type="button" className="button" onClick={() => setAsking(false)}>Cancelar</button>
    </span>
    : <button type="button" className="button" disabled={busy} onClick={() => setAsking(true)}>Instalar…</button>;
}

function Group({ title, pieces, busy, onStart }: { title: string; pieces: DoctorPiece[]; busy: boolean; onStart: (id: string) => void }) {
  if (!pieces.length) return null;
  return <section className="install-group" aria-label={title}>
    <h3>{title}</h3>
    <ul className="install-list">{pieces.map(piece => <li key={piece.id} className={`install-row install-piece ${piece.state}`}>
      <span className={`status-badge ${piece.state === 'ok' ? 'good' : piece.state === 'missing' ? 'bad' : 'paused'}`}>{labels[piece.state]}</span>
      <div className="install-text">
        <strong>{piece.name}</strong>
        <small className="muted">{piece.modules.join(' · ')}</small>
        {piece.detail && <small>{piece.detail}</small>}
        {piece.state !== 'ok' && <How how={piece.how}/>}
        {piece.state !== 'ok' && <InstallButton piece={piece} busy={busy} onStart={onStart}/>}
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
  const pieces = found?.pieces ?? [];
  const [job, setJob] = useState<InstallJob | null>(null);
  const timer = useRef(0);
  // While something installs, its progress is read every two seconds; when it ends, the diagnosis is redone.
  const follow = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void getInstallJob().then(({ job: next }) => {
      setJob(next);
      if (next?.state === 'running') follow(); else load();
    }).catch(() => follow()), 2000);
  };
  const start = async (id: string) => {
    setError('');
    try { setJob((await installPiece(id)).job); follow(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo empezar.'); }
  };
  if (!asked.current) { asked.current = true; load(); void getInstallJob().then(({ job: current }) => { setJob(current); if (current?.state === 'running') follow(); }).catch(() => undefined); }
  const busy = job?.state === 'running';
  return <article className="card" aria-labelledby="install-title">
    <div className="card-head"><h2 id="install-title">Qué tengo instalado</h2>
      {found && <span className={`status-badge ${found.missing ? 'bad' : 'good'}`}>{found.missing ? `Faltan ${found.missing}` : 'Todo listo'}</span>}</div>
    <p>Lo que AgoraOne puede usar en este equipo, para qué módulo sirve cada pieza y cómo conseguir lo que falta. Comprobarlo no cambia nada.</p>
    {!found && !error ? <Loading label="Comprobando lo instalado" lines={4}/> : found && <>
      <p className="muted">{found.summary} <button type="button" className="button" onClick={() => { setFound(null); load(); }}>Volver a comprobar</button>
        {' '}<button type="button" className="button" onClick={showFirstRunAgain}>Ver la guía de inicio</button></p>
      {job && <div className={`install-job ${job.state}`} role="status" aria-live="polite">
        <strong>{job.state === 'running' ? `Instalando ${job.name}…` : job.state === 'done' ? `${job.name}: instalado.` : `${job.name}: ${job.error ?? 'no se pudo instalar.'}`}</strong>
        {job.total > 0 && job.state === 'running' && <div className="music-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (job.done / job.total) * 100)}%` }}/></div>}
        {job.lines.length > 0 && <pre className="install-log">{job.lines.slice(-8).join('\n')}</pre>}
      </div>}
      <Group title="Necesarias para algún módulo" pieces={pieces.filter(p => p.state !== 'optional' && !COMPATIBLE.has(p.id))} busy={busy} onStart={id => void start(id)}/>
      <Group title="Opcionales" pieces={pieces.filter(p => p.state === 'optional' && !COMPATIBLE.has(p.id))} busy={busy} onStart={id => void start(id)}/>
      <Group title="Compatibilidad (próximamente)" pieces={pieces.filter(p => COMPATIBLE.has(p.id))} busy={busy} onStart={id => void start(id)}/>
    </>}
    {error && <LoadError message={error}/>}
  </article>;
}
