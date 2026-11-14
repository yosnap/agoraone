import { useEffect, useState } from 'react';
import { createBackup, getBackups, type Backup } from '../api/core';
import { Loading, LoadError } from '../ui/load-state';

const kinds: Record<string, string> = { daily: 'Diaria', weekly: 'Semanal', manual: 'Manual', 'pre-migration': 'Previa a migración', premigration: 'Previa a migración' };
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Encrypted copies of the brain's database; restoring is done from the terminal (docs/arranque.md). */
export function BackupsCard() {
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [pendingKey, setPendingKey] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const load = () => getBackups().then(data => { setBackups(data.backups); setPendingKey(data.recoveryKeyPending); setError(''); })
    .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las copias.'));
  useEffect(() => { void load(); }, []);
  const make = async () => {
    setBusy(true); setError(''); setDone('');
    try { const made = await createBackup(); setDone(`Copia ${made.name} creada.`); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo hacer la copia.'); }
    finally { setBusy(false); }
  };
  return <article className="card" aria-labelledby="settings-backups">
    <div className="card-head"><h2 id="settings-backups">Copias de seguridad</h2><button className="button primary" disabled={busy} onClick={() => void make()}>{busy ? 'Copiando…' : 'Hacer copia ahora'}</button></div>
    <p>Copias cifradas (AES-256-GCM, clave en el Llavero) de la base del cerebro: una diaria automática; se guardan 14 diarias, 8 semanales, 10 manuales y 5 previas a migraciones. Se restauran desde la terminal.</p>
    {pendingKey && <p className="chip warn" role="alert">Falta guardar la clave de recuperación: ejecuta «recovery-key» en tu terminal (docs/arranque.md).</p>}
    {error ? <LoadError message={error} onRetry={() => void load()}/> : !backups ? <Loading label="Leyendo las copias" lines={3}/> : !backups.length ? <p className="muted">Aún no hay copias.</p>
      : <table className="data-table"><thead><tr><th>Fecha</th><th>Tipo</th><th className="num">Tamaño</th></tr></thead>
        <tbody>{backups.slice(0, 12).map(backup => <tr key={backup.name}><td>{new Date(backup.created).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</td>
          <td>{kinds[backup.kind] ?? backup.kind}</td><td className="num">{size(backup.bytes)}</td></tr>)}</tbody></table>}
    {backups && backups.length > 12 && <small className="muted">Y {backups.length - 12} copias más antiguas.</small>}
    {done && <span className="ok-note" role="status">{done}</span>}
  </article>;
}
