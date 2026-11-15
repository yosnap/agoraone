import { useRef, useState } from 'react';
import { getHermesActivity, getHermesCatalog, getHermesWork } from '../api/client';
import type { HermesWork, WorkCard, WorkTask, WorkTokens } from '../../shared/hermes-work';
import { statusLabel, when } from '../data/activity-format';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { CardControls, JobManager } from '../ui/profile-tasks';
import { cost, count, duration, tokens } from './work-format';
import './jobs.css';

type Period = '24h' | '7d' | '30d';
const periods: { id: Period; label: string; days: number }[] = [{ id: '24h', label: '24 h', days: 1 }, { id: '7d', label: '7 días', days: 7 }, { id: '30d', label: '30 días', days: 30 }];
const ALL = '';
const REFRESH = 60_000;
// Hermes' kanban states, grouped in the columns people think in.
const columns: { title: string; states: string[] }[] = [
  { title: 'Por hacer', states: ['triage', 'todo', 'ready'] },
  { title: 'En curso', states: ['claimed', 'running', 'review'] },
  { title: 'Bloqueadas', states: ['blocked', 'failed', 'crashed', 'timed_out'] },
  { title: 'Hechas', states: ['done', 'archived'] },
];

function TaskRuns({ task, period, discreet }: { task: WorkTask; period: Period; discreet: boolean }) {
  const total = task.totals[period];
  const label = periods.find(p => p.id === period)!.label;
  return <div className="work-runs">
    <small>En {label}: {total.runs === 1 ? '1 ejecución' : `${total.runs} ejecuciones`}{total.runs ? ` · ${duration(total.seconds)} · ${total.measured ? tokens(total.tokens) : 'tokens sin medir'}` : ''}</small>
    {task.runs.length > 0 && <details><summary>Últimas ejecuciones</summary>
      <table className="work-table"><thead><tr><th>Cuándo</th><th>Resultado</th><th>Duración</th><th>Consumo</th></tr></thead>
        <tbody>{task.runs.map((run, index) => <tr key={index}>
          <td>{when(run.startedAt ?? run.finishedAt)}</td><td>{statusLabel(run.status)}</td><td>{duration(run.seconds)}</td><td>{discreet ? '•••' : tokens(run.tokens)}</td>
        </tr>)}</tbody></table>
    </details>}
  </div>;
}

function Card({ card, label, discreet, onChanged }: { card: WorkCard; label: string; discreet: boolean; onChanged: () => void }) {
  const open = !['done', 'archived'].includes(card.status);
  return <li className="work-card">
    <strong>{discreet ? '•••' : card.title}</strong>
    <small>{label} · {statusLabel(card.status)}{card.board !== 'default' ? ` · tablero ${card.board}` : ''}{card.createdBy === 'agoraone' ? ' · encargo de AgoraOne' : ''}</small>
    <small>Creada {when(card.createdAt)}{card.runs.length ? ` · ${card.runs.length === 1 ? '1 ejecución' : `${card.runs.length} ejecuciones`}` : ''}
      {card.seconds !== null ? ` · ${duration(card.seconds)}` : ''}{card.tokens && !discreet ? ` · ${tokens(card.tokens)}` : ''}</small>
    {open && card.id && card.profileId && card.board === 'default' && !discreet && <CardControls profileId={card.profileId} card={{ id: card.id, title: card.title, status: card.status }} onChanged={onChanged}/>}
  </li>;
}

/** Everything the Hermes profiles do or have pending: their scheduled tasks and the shared kanban board, with
 * the time and tokens Hermes recorded for each run. Changes go through the same buttons as each profile's card. */
export function JobsView({ discreet }: { discreet: boolean }) {
  const [work, setWork] = useState<HermesWork | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [gateway, setGateway] = useState('missing');
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('7d');
  const [profile, setProfile] = useState(ALL);
  const started = useRef(false);
  const load = async () => {
    try {
      const [found, activity] = await Promise.all([getHermesWork(), getHermesActivity().catch(() => null)]);
      setWork(found); setError('');
      if (activity) setGateway(activity.gateway.state);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudieron leer los trabajos.'); }
  };
  if (!started.current) {
    started.current = true;
    void load();
    getHermesCatalog().then(catalog => setLabels(Object.fromEntries(catalog.profiles.map(p => [p.id, p.label || p.name])))).catch(() => undefined);
    const tick = () => { if (document.visibilityState === 'visible') void load(); window.setTimeout(tick, REFRESH); };
    window.setTimeout(tick, REFRESH);
  }
  const labelOf = (id: string | null, fallback: string | null = null) => (id && labels[id]) || fallback || id || 'sin perfil';
  const profiles = work ? Object.entries(work.profiles).filter(([id]) => profile === ALL || id === profile) : [];
  const cards = (work?.board?.cards ?? []).filter(card => profile === ALL || card.profileId === profile);
  // The period's totals: task runs plus the cards created in it.
  const since = Date.now() - periods.find(p => p.id === period)!.days * 86_400_000;
  const sum: { runs: number; seconds: number; tokens: WorkTokens; measured: boolean } = { runs: 0, seconds: 0, tokens: { input: 0, output: 0, costUsd: null }, measured: false };
  const addTokens = (used: WorkTokens) => {
    sum.tokens.input += used.input; sum.tokens.output += used.output; sum.measured = true;
    if (used.costUsd !== null) sum.tokens.costUsd = (sum.tokens.costUsd ?? 0) + used.costUsd;
  };
  for (const [, entry] of profiles) for (const task of entry.tasks ?? []) {
    const total = task.totals[period];
    sum.runs += total.runs; sum.seconds += total.seconds;
    if (total.measured) addTokens(total.tokens);
  }
  for (const card of cards) if (card.createdAt && Date.parse(card.createdAt) >= since) {
    sum.runs += card.runs.length; sum.seconds += card.seconds ?? 0;
    if (card.tokens) addTokens(card.tokens);
  }
  return <section className="page jobs" aria-labelledby="jobs-title">
    <div className="eyebrow">TRABAJOS{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="jobs-title">Trabajos</h1>
    <p className="page-lead">Las tareas programadas y el kanban de todos tus perfiles de Hermes, con el tiempo y los tokens que Hermes ha registrado en cada ejecución. Los cambios usan las funciones de Hermes y solo ocurren al pulsar cada botón.</p>
    <div className="fiscal-bar">
      <div className="segmented" role="group" aria-label="Periodo">{periods.map(p =>
        <button key={p.id} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>)}</div>
      <label className="field jobs-filter">Perfil<ModernSelect value={profile} onChange={setProfile}
        options={[{ value: ALL, label: 'Todos los perfiles' }, ...Object.keys(work?.profiles ?? {}).map(id => ({ value: id, label: labelOf(id) }))]}/></label>
      <button type="button" className="button" onClick={() => void load()}>Actualizar</button>
    </div>
    {error && <LoadError message={error}/>}
    {!work && !error ? <Loading label="Leyendo los trabajos de Hermes" lines={4}/> : work && <>
      <dl className="work-totals" aria-label="Totales del periodo">
        <div><dt>Ejecuciones</dt><dd>{sum.runs}</dd></div>
        <div><dt>Tiempo</dt><dd>{duration(sum.seconds)}</dd></div>
        <div><dt>Tokens</dt><dd>{discreet ? '•••' : sum.measured ? count(sum.tokens.input + sum.tokens.output) : 'sin medir'}</dd></div>
        <div><dt>Coste estimado</dt><dd>{discreet ? '•••' : cost(sum.tokens.costUsd) ?? '—'}</dd></div>
      </dl>
      <h2>Tareas programadas</h2>
      {gateway !== 'running' && <p className="fiscal-warning">El gateway de Hermes no está en marcha: las tareas no se ejecutarán hasta que arranque.</p>}
      {profiles.every(([, entry]) => !entry.tasks?.length) ? <p className="muted">Ningún perfil tiene tareas programadas.</p>
        : profiles.filter(([, entry]) => entry.tasks?.length).map(([id, entry]) => <article key={id} className="card work-profile">
          <h3>{labelOf(id, entry.name)}</h3>
          {discreet ? <p className="muted">{entry.tasks!.length === 1 ? '1 tarea' : `${entry.tasks!.length} tareas`}; nombres ocultos en modo discreto.</p>
            : <JobManager profileId={id} jobs={entry.tasks} gateway={gateway} onChanged={() => void load()} extra={task => <TaskRuns task={task} period={period} discreet={discreet}/>}/>}
        </article>)}
      <h2>Kanban</h2>
      {!work.board ? <p className="muted">El tablero kanban de Hermes no está disponible.</p>
        : !cards.length ? <p className="muted">No hay tarjetas{profile === ALL ? '' : ' de este perfil'} en el tablero.</p>
        : <div className="work-board">{columns.map(column => {
          // A state Hermes adds later still shows, in the first column.
          const inColumn = cards.filter(card => column.states.includes(card.status) || (column === columns[0] && !columns.some(c => c.states.includes(card.status))));
          return <section key={column.title} className="work-column" aria-label={column.title}>
            <h3>{column.title} <span className="muted">{inColumn.length}</span></h3>
            <ul>{inColumn.map((card, index) => <Card key={card.id ?? index} card={card} label={labelOf(card.profileId, card.assignee)} discreet={discreet} onChanged={() => void load()}/>)}</ul>
          </section>;
        })}</div>}
    </>}
  </section>;
}
