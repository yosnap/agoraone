import { useRef, useState } from 'react';
import { takeJobsTab } from './jobs-tab';
import { getHermesActivity, getHermesCatalog, getHermesWork } from '../api/client';
import { getJobsSettings } from '../api/core';
import type { HermesWork, WorkCard, WorkTask, WorkTokens } from '../../shared/hermes-work';
import { statusLabel, when } from '../data/activity-format';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { CardControls, JobManager, useAction, type ActionState } from '../ui/profile-tasks';
import { cost, count, duration, tokens } from './work-format';
import { CardHistory } from './card-history';
import { ClientProjectsSection } from './client-projects';
import { ClientsDirectoryView } from './clients-directory';
import { CommissionForm, type ProfileChoice } from './commission-form';
import './jobs.css';
import { ActionButton } from '../ui/action-button';

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

function Card({ card, label, discreet, action }: { card: WorkCard; label: string; discreet: boolean; action: ActionState }) {
  const open = !['done', 'archived'].includes(card.status);
  return <li className="work-card">
    <strong>{discreet ? '•••' : card.title}</strong>
    <small>{label} · {statusLabel(card.status)}{card.board !== 'default' && !discreet ? ` · tablero ${card.board}` : ''}{card.createdBy === 'agoraone' ? ' · encargo de AgoraOne' : ''}</small>
    <small>Creada {when(card.createdAt)}{card.runs.length ? ` · ${card.runs.length === 1 ? '1 ejecución' : `${card.runs.length} ejecuciones`}` : ''}
      {card.seconds !== null ? ` · ${duration(card.seconds)}` : ''}{card.tokens && !discreet ? ` · ${tokens(card.tokens)}` : ''}</small>
    <CardHistory card={card}/>
    {open && card.id && card.profileId && card.board === 'default' && !discreet && <CardControls profileId={card.profileId} card={{ id: card.id, title: card.title, status: card.status }} action={action}/>}
  </li>;
}

/** Everything the Hermes profiles do or have pending: their scheduled tasks and the shared kanban board, with
 * the time and tokens Hermes recorded for each run. Changes go through the same buttons as each profile's card. */
export function JobsView({ discreet }: { discreet: boolean }) {
  const [work, setWork] = useState<HermesWork | null>(null);
  const [profileList, setProfileList] = useState<ProfileChoice[]>([]);
  // Known only once both the catalog and the setting have been read: until then there is no «Nuevo encargo».
  const [central, setCentral] = useState<string | null>(null);
  const [commissioning, setCommissioning] = useState(false);
  const labels: Record<string, string> = Object.fromEntries(profileList.map(p => [p.id, p.label]));
  // Unknown until read: no «not running» warning on a guess.
  const [gateway, setGateway] = useState('unknown');
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('7d');
  const [profile, setProfile] = useState(ALL);
  const [tab, setTab] = useState<'work' | 'clients'>(takeJobsTab);
  const onClients = useRef(false);  // the timer does not refresh the work while the «Clientes» tab is open
  onClients.current = tab === 'clients';
  const started = useRef(false);
  const request = useRef(0);
  // The refresh lives while the section is on screen: leaving it stops the timer.
  const timer = useRef<number | undefined>(undefined);
  const holder = useRef((node: HTMLElement | null) => { if (!node) window.clearTimeout(timer.current); }).current;
  const load = async () => {
    const mine = ++request.current;
    try {
      const [found, activity] = await Promise.all([getHermesWork(), getHermesActivity().catch(() => null)]);
      if (mine !== request.current) return;
      setWork(found); setError('');
      setGateway(activity ? activity.gateway.state : 'unknown');
    } catch (failure) { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudieron leer los trabajos.'); }
  };
  const action = useAction(() => void load());
  if (!started.current) {
    started.current = true;
    void load();
    getHermesCatalog().then(catalog => setProfileList(catalog.profiles.map(p => ({ id: p.id, name: p.name, label: p.label || p.name })))).catch(() => undefined);
    getJobsSettings().then(found => setCentral(found.central)).catch(() => setCentral('default'));
    const tick = () => {
      // Not while a comment, block reason or task is being written: a card moving column would lose it.
      if (document.visibilityState === 'visible' && !onClients.current && !document.querySelector('section.jobs .task-form')) void load();
      timer.current = window.setTimeout(tick, REFRESH);
    };
    timer.current = window.setTimeout(tick, REFRESH);
  }
  const labelOf = (id: string | null, fallback: string | null = null) => (id && labels[id]) || fallback || id || 'sin perfil';
  const profiles = work ? Object.entries(work.profiles).filter(([id]) => profile === ALL || id === profile) : [];
  const cards = (work?.board?.cards ?? []).filter(card => profile === ALL || card.profileId === profile);
  // The period's totals: every run of the tasks and cards by when it ran.
  const sum: { runs: number; seconds: number; tokens: WorkTokens; measured: number } = { runs: 0, seconds: 0, tokens: { input: 0, output: 0, costUsd: null }, measured: 0 };
  const add = (total: WorkTask['totals'][Period]) => {
    sum.runs += total.runs; sum.seconds += total.seconds; sum.measured += total.measured;
    sum.tokens.input += total.tokens.input; sum.tokens.output += total.tokens.output;
    if (total.tokens.costUsd !== null) sum.tokens.costUsd = (sum.tokens.costUsd ?? 0) + total.tokens.costUsd;
  };
  for (const [, entry] of profiles) for (const task of entry.tasks ?? []) add(task.totals[period]);
  for (const card of cards) if (card.totals) add(card.totals[period]);
  const partial = sum.measured > 0 && sum.measured < sum.runs;
  // Whether a new commission will be picked up: the gateway runs Hermes' kanban dispatcher unless its config turns it off.
  const ready = work && !work.dispatcher ? { ok: false, why: 'La configuración del perfil raíz de Hermes desactiva el despachador del kanban en su gateway (kanban.dispatch_in_gateway): puede que nadie recoja el encargo, salvo que el gateway de otro perfil lo tenga activo.' }
    : ['stopped', 'stale', 'missing'].includes(gateway) ? { ok: false, why: 'El gateway de Hermes no está en marcha: el encargo esperará en el kanban hasta que arranque.' }
    : { ok: true, why: '' };
  return <section className="page jobs" aria-labelledby="jobs-title" ref={holder}>
    <div className="eyebrow">TRABAJOS{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="jobs-title">Trabajos</h1>
    <p className="page-lead">Las tareas programadas y el kanban de todos tus perfiles de Hermes, con el tiempo y los tokens que Hermes ha registrado en cada ejecución. Los cambios usan las funciones de Hermes y solo ocurren al pulsar cada botón.</p>
    <div className="segmented jobs-tabs" role="group" aria-label="Pestañas de Trabajos">
      <button aria-pressed={tab === 'work'} onClick={() => setTab('work')}>Trabajos</button>
      <button aria-pressed={tab === 'clients'} onClick={() => setTab('clients')}>Clientes</button>
    </div>
    {tab === 'clients' ? <ClientsDirectoryView discreet={discreet}/> : <>
    <div className="fiscal-bar">
      <div className="segmented" role="group" aria-label="Periodo">{periods.map(p =>
        <button key={p.id} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>)}</div>
      <label className="field jobs-filter">Perfil<ModernSelect value={profile} onChange={setProfile}
        options={[{ value: ALL, label: 'Todos los perfiles' }, ...Object.keys(work?.profiles ?? {}).map(id => ({ value: id, label: labelOf(id) }))]}/></label>
      <ActionButton icon="refresh" label="Actualizar" onClick={() => void load()}/>
    </div>
    {error && <LoadError message={error}/>}
    {!work && !error ? <Loading label="Leyendo los trabajos de Hermes" lines={4}/> : work && <>
      <dl className="work-totals" aria-label="Totales del periodo">
        <div><dt>Ejecuciones</dt><dd>{sum.runs}</dd></div>
        <div><dt>Tiempo</dt><dd>{duration(sum.seconds)}</dd></div>
        <div><dt>Tokens{partial ? ' (parcial)' : ''}</dt><dd>{discreet ? <span aria-label="oculto">•••</span> : sum.measured ? count(sum.tokens.input + sum.tokens.output) : 'sin medir'}</dd></div>
        <div><dt>Coste estimado{partial ? ' (parcial)' : ''}</dt><dd>{discreet ? <span aria-label="oculto">•••</span> : cost(sum.tokens.costUsd) ?? '—'}</dd></div>
      </dl>
      <h2>Tareas programadas</h2>
      {['stopped', 'stale', 'missing'].includes(gateway) && <p className="fiscal-warning">El gateway de Hermes no está en marcha: las tareas no se ejecutarán hasta que arranque.</p>}
      {profiles.every(([, entry]) => !entry.tasks?.length) ? <p className="muted">Ningún perfil tiene tareas programadas.</p>
        : profiles.filter(([, entry]) => entry.tasks?.length).map(([id, entry]) => <article key={id} className="card work-profile">
          <h3>{labelOf(id, entry.name)}</h3>
          {discreet ? <p className="muted">{entry.tasks!.length === 1 ? '1 tarea' : `${entry.tasks!.length} tareas`}; nombres ocultos en modo discreto.</p>
            : <JobManager profileId={id} jobs={entry.tasks} gateway={gateway} onChanged={() => void load()} extra={task => <TaskRuns task={task} period={period} discreet={discreet}/>}/>}
        </article>)}
      <div className="jobs-heading"><h2>Kanban y encargos</h2>
        {!commissioning && !discreet && central !== null && profileList.length > 0 && <ActionButton icon="plus" label="Nuevo encargo" tone="primary" onClick={() => { setCommissioning(true); action.say(''); }}/>}</div>
      {commissioning && !discreet && central !== null && <CommissionForm profiles={profileList} central={central} ready={ready} onCancel={() => setCommissioning(false)}
        onDone={note => { setCommissioning(false); action.say(note); void load(); }}/>}
      {action.error && <p role="alert" className="error">{action.error}</p>}
      {action.done && !discreet && <p role="status" className="task-done">{action.done}</p>}
      {!work.board ? <p className="muted">El tablero kanban de Hermes no está disponible.</p>
        : !cards.length ? <p className="muted">No hay tarjetas{profile === ALL ? '' : ' de este perfil'} en el tablero.</p>
        : <div className="work-board">{columns.map(column => {
          // A state Hermes adds later still shows, in the first column.
          const inColumn = cards.filter(card => column.states.includes(card.status) || (column === columns[0] && !columns.some(c => c.states.includes(card.status))));
          return <section key={column.title} className="work-column" aria-label={column.title}>
            <h3>{column.title} <span className="muted">{inColumn.length}</span></h3>
            <ul>{inColumn.map((card, index) => <Card key={card.id ?? index} card={card} label={labelOf(card.profileId, card.assignee)} discreet={discreet} action={action}/>)}</ul>
          </section>;
        })}</div>}
      <h2>Proyectos de clientes</h2>
      <ClientProjectsSection period={period} discreet={discreet}/>
    </>}
    </>}
  </section>;
}
