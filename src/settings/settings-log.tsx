import { useEffect, useRef, useState } from 'react';
import { getLogs, type LogEntry, type LogLevel } from '../api/core';
import { Loading, LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import '../about/about.css';

const levels: Record<LogLevel, { label: string; icon: string }> = {
  debug: { label: 'Detalle', icon: '·' },
  info: { label: 'Información', icon: 'i' },
  warning: { label: 'Aviso', icon: '!' },
  error: { label: 'Error', icon: '×' },
};
const levelOptions = [{ value: 'info', label: 'Información y más' }, { value: 'warning', label: 'Avisos y errores' }, { value: 'error', label: 'Solo errores' }];
const sourceOptions = [{ value: '', label: 'Todo' }, { value: 'núcleo', label: 'Núcleo' }, { value: 'interfaz', label: 'Interfaz' }];
const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const size = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;

/** What happens in AgoraOne: start, warnings and errors of the core and of the interface (Ajustes › Registro). */
export function LogCard() {
  const [level, setLevel] = useState<LogLevel>('info');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<{ entries: LogEntry[]; bytes: number; maxBytes: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const load = () => {
    const asked = ++latest.current;  // a slow earlier answer never replaces the one for the current filters
    setBusy(true);
    getLogs({ level, q: query, source: (source || undefined) as LogEntry['source'] | undefined })
      .then(found => { if (asked === latest.current) { setData(found); setError(''); } })
      .catch(failure => { if (asked === latest.current) setError(failure instanceof Error ? failure.message : 'No se pudo leer el registro.'); })
      .finally(() => { if (asked === latest.current) setBusy(false); });
  };
  useEffect(load, [level, source, query]);
  return <article className="card about-card" aria-labelledby="settings-log">
    <div className="card-head"><h2 id="settings-log">Registro</h2>
      <button className="button" disabled={busy} onClick={load}>{busy ? 'Leyendo…' : 'Actualizar'}</button></div>
    <p>Lo que pasa en AgoraOne: el arranque y los avisos y errores del núcleo y de la interfaz. Se guarda solo en este equipo, nunca va a un modelo, oculta las líneas con pinta de clave y no guarda textos de correos ni mensajes. Ocupa como mucho {data ? size(data.maxBytes) : '5 MB'}: lo más antiguo se descarta solo.</p>
    <form className="log-filters" onSubmit={event => { event.preventDefault(); setQuery(text); }}>
      <label className="field">Nivel<ModernSelect value={level} options={levelOptions} onChange={value => setLevel(value as LogLevel)}/></label>
      <label className="field">Origen<ModernSelect value={source} options={sourceOptions} onChange={setSource}/></label>
      <label className="field log-search">Buscar<input type="search" value={text} onChange={event => setText(event.target.value)} placeholder="Texto o área" maxLength={200}/></label>
      <button className="button" type="submit">Buscar</button>
    </form>
    {error ? <LoadError message={error} onRetry={load}/> : !data ? <Loading label="Leyendo el registro" lines={4}/>
      : !data.entries.length ? <p className="muted">No hay entradas con estos filtros.</p>
      : <>
        <p className="muted">{data.entries.length === 1 ? '1 entrada' : `${data.entries.length} entradas`}, de la más reciente a la más antigua · {size(data.bytes)} en disco.</p>
        <div className="log-table-wrap"><table className="data-table log-table">
          <thead><tr><th>Hora</th><th>Nivel</th><th>Origen</th><th>Área</th><th>Mensaje</th></tr></thead>
          <tbody>{data.entries.map((entry, index) => <tr key={`${entry.t}-${index}`}>
            <td className="log-time"><time dateTime={entry.t}>{when(entry.t)}</time></td>
            <td><span className={`about-kind log-${entry.level}`}><span aria-hidden="true">{levels[entry.level].icon}</span> {levels[entry.level].label}</span></td>
            <td>{entry.source === 'núcleo' ? 'Núcleo' : 'Interfaz'}</td>
            <td className="log-area">{entry.area}</td>
            <td className="log-message">{entry.message}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
  </article>;
}
