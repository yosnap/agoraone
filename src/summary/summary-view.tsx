import { CentralCard } from './central-card';
import { ClientsFollowCard } from './clients-follow-card';
import { CrmdevPendingCard } from './crmdev-pending-card';
import type { Section } from '../shell/shell-state';
import { moduleOn, useModules } from '../shell/modules';
import { useAssistantName } from '../assistant/assistant-name';
import { useEffect, useState } from 'react';
import { ago } from '../data/activity-format';
import { engineName, modelName } from '../assistant/assistant-labels';
import { levelLabels } from '../api/core';
import type { NoteRef } from '../brain/note-reader';
import { Loading, LoadError } from '../ui/load-state';
import { compact, connectedAgents, uptime, useSummary, type Summary } from './use-summary';
import './summary.css';

type Row = { label: string; value: number; sub?: string };
type Window = '24h' | '7d' | '30d';
const windows: Record<Window, string> = { '24h': '24 h', '7d': '7 días', '30d': '30 días' };

/** A ranked list drawn as bars relative to its largest value. */
function Bars({ rows, format = compact, empty }: { rows: Row[]; format?: (value: number) => string; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map(row => row.value), 1);
  return <ol className="bars">{rows.map((row, index) => <li key={`${row.label}-${index}`}>
    <span className="bars-label" title={row.label}>{row.label}{row.sub && <small>{row.sub}</small>}</span>
    <span className="bars-track" aria-hidden="true"><span style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}/></span>
    <span className="bars-value">{format(row.value)}</span>
  </li>)}</ol>;
}

/** Words as a heat strip: the bigger the count, the warmer and larger. */
function Words({ words, empty }: { words: { word: string; count: number }[]; empty: string }) {
  if (!words.length) return <p className="muted">{empty}</p>;
  const max = words[0].count;
  return <ul className="word-heat">{words.slice(0, 30).map(item => {
    const heat = item.count / max;
    return <li key={item.word} style={{ fontSize: `${11 + heat * 9}px`, opacity: 0.55 + heat * 0.45 }} data-heat={heat > 0.66 ? 'high' : heat > 0.33 ? 'mid' : 'low'}
      title={`${item.count} veces`}>{item.word}</li>;
  })}</ul>;
}

function Status({ summary, now }: { summary: Summary; now: number }) {
  const assistant = useAssistantName();
  const agents = connectedAgents(summary);
  const gateway = summary.activity?.gateway;
  const online = !!summary.engine?.active;
  return <article className="card summary-status" aria-labelledby="summary-status">
    <h2 id="summary-status">Estado</h2>
    <dl className="figures">
      <div><dt>{assistant}</dt><dd className={online ? 'good' : 'bad'}>{online ? 'En línea' : summary.engine ? 'Sin motor' : '—'}</dd></div>
      <div><dt>En línea desde hace</dt><dd>{summary.core ? uptime(summary.core.core.startedAt, now) : '—'}</dd></div>
      <div><dt>Motor</dt><dd>{summary.engine?.active ? `${engineName(summary.engine.active)} · ${modelName(summary.engine.model)}` : '—'}</dd></div>
      <div><dt>Gateway de Hermes</dt><dd className={gateway?.state === 'running' ? 'good' : 'bad'}>{gateway ? { running: 'En marcha', stopped: 'Parado', stale: 'Sin señal', missing: 'No encontrado' }[gateway.state] : '—'}</dd></div>
    </dl>
    <h3>Agentes conectados <span className="chip">{agents.length}</span></h3>
    {agents.length ? <ul className="agent-list">{agents.map(agent => <li key={agent.id}>
      <span className="agent-dot" style={{ background: agent.color }} aria-hidden="true"/><strong>{agent.label}</strong>
      <small>{agent.platforms.join(', ')}{agent.last ? ` · actividad ${ago(agent.last)}` : ''}</small>
    </li>)}</ul> : <p className="muted">Ningún perfil de Hermes tiene ahora una plataforma conectada.</p>}
    {summary.core && <small className="muted">Núcleo {summary.core.core.version}</small>}
  </article>;
}

/** The whole picture: status, connected agents, tokens per project and agent, Watson's questions and the
 * words used most. Real data only; each source that fails is named. */
export function SummaryView({ discreet, onRead, onOpen }: { discreet: boolean; onRead: (note: NoteRef) => void; onOpen: (section: Section) => void }) {
  const assistant = useAssistantName();
  const modules = useModules();
  const centralOn = moduleOn(modules, 'central');
  const { summary, reload } = useSummary(discreet);
  const [window, setWindow] = useState<Window>('7d');
  const [words, setWords] = useState<'notes' | 'questions' | 'hermes'>('notes');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  if (!summary.readAt) return <section className="page"><Loading label="Preparando el resumen" lines={6}/></section>;
  const { core, hermes } = summary;
  const costguard = core?.costguard.available ? core.costguard[window] : null;
  const brain = core?.brain;
  return <section className="page summary" aria-labelledby="summary-title">
    <div className="eyebrow">RESUMEN{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="summary-title">Resumen</h1>
    <p className="page-lead">Cómo está todo ahora mismo. Se actualiza cada minuto; leído en este Mac, sin llamadas a modelos.</p>
    {summary.errors.length > 0 && <LoadError message={`No se pudo leer ${summary.errors.join(', ')}.`} onRetry={reload}/>}
    <div className="summary-grid">
      <Status summary={summary} now={now}/>
      <article className="card summary-wide" aria-labelledby="summary-projects">
        <div className="card-head"><h2 id="summary-projects">Proyectos con más consumo de tokens</h2>
          <div className="segmented" role="group" aria-label="Periodo">{(Object.keys(windows) as Window[]).map(key =>
            <button key={key} aria-pressed={window === key} onClick={() => setWindow(key)}>{windows[key]}</button>)}</div></div>
        <div className="summary-split">
          <div><h3>CostGuard · {windows[window]}</h3>
            {core?.costguard.available ? <Bars rows={(costguard?.projects ?? []).map(p => ({ label: p.project, value: p.tokens, sub: `${p.turns} turnos` }))} empty="Sin consumo en este periodo."/>
              : <p className="muted">CostGuard no está configurado o no se encuentra (Conectores).</p>}</div>
          <div><h3>Hermes · 30 días</h3>
            <Bars rows={(hermes?.projects ?? []).slice(0, 15).map(p => ({ label: p.project, value: p.tokens, sub: `${p.sessions} sesiones${p.costUsd ? ` · ${p.costUsd.toFixed(2)} $` : ''}` }))} empty="Tus sesiones de Hermes de estos 30 días no trabajan en ninguna carpeta (por ejemplo, las de Telegram), así que no se atribuyen a un proyecto. Sus tokens están en «Tokens por agente»."/></div>
        </div>
      </article>
      <article className="card" aria-labelledby="summary-agents">
        <h2 id="summary-agents">Tokens por agente</h2>
        <h3>CostGuard · {windows[window]}</h3>
        <Bars rows={(costguard?.agents ?? []).map(a => ({ label: a.agent, value: a.input + a.output, sub: `${compact(a.cacheRead + a.cacheWrite)} en caché` }))} empty="Sin datos de CostGuard."/>
        <h3>Perfiles de Hermes · 30 días</h3>
        <Bars rows={(hermes?.profiles ?? []).map(p => ({ label: summary.catalog?.profiles.find(x => x.name === p.profile)?.label ?? p.profile, value: p.tokens, sub: `${p.sessions} sesiones${p.costUsd ? ` · ${p.costUsd.toFixed(2)} $` : ''}` }))} empty="Sin sesiones de Hermes."/>
      </article>
      <article className="card" aria-labelledby="summary-watson">
        <h2 id="summary-watson">{assistant}</h2>
        <dl className="figures">
          <div><dt>Preguntas</dt><dd>{core?.watson.questions ?? '—'}</dd></div>
          <div><dt>Últimas 24 h</dt><dd>{core?.watson.questions24h ?? '—'}</dd></div>
          <div><dt>Conversaciones</dt><dd>{core?.watson.conversations ?? '—'}</dd></div>
          <div><dt>Sin respuesta</dt><dd>{core?.watson.failed ?? '—'}</dd></div>
        </dl>
        <h3>Consultas con más impacto</h3>
        <Bars rows={(core?.watson.impact ?? []).map(i => ({ label: i.question, value: i.sources, sub: new Date(i.at).toLocaleDateString('es-ES') }))} format={value => `${value} notas`} empty="Aún no hay preguntas respondidas."/>
        <h3>Búsquedas que más repite</h3>
        <Bars rows={(core?.watson.searches ?? []).map(s => ({ label: s.query, value: s.count }))} format={value => `${value}×`} empty={`${assistant} aún no ha buscado por su cuenta.`}/>
      </article>
      <article className="card" aria-labelledby="summary-cited">
        <h2 id="summary-cited">Notas más citadas</h2>
        {core?.watson.cited.length ? <ol className="cited">{core.watson.cited.map(note => <li key={`${note.source}/${note.ref}`}>
          <button onClick={() => onRead({ vault: note.source, note: note.ref })}>{note.title}</button><small>{note.folder || 'Raíz'} · {note.count}×</small>
        </li>)}</ol> : <p className="muted">Ninguna nota citada todavía.</p>}
        <h3>Cerebro</h3>
        {brain && <dl className="figures">
          <div><dt>Notas</dt><dd>{brain.notes}</dd></div>
          <div><dt>Fragmentos</dt><dd>{brain.chunks}</dd></div>
          {(['normal', 'local_only', 'private'] as const).filter(level => !discreet || level === 'normal').map(level =>
            <div key={level}><dt>{levelLabels[level]}</dt><dd>{brain.byConfidentiality[level] ?? 0}</dd></div>)}
          <div><dt>Significado</dt><dd>{brain.pendingEmbeddings ? `faltan ${brain.pendingEmbeddings}` : 'completo'}</dd></div>
        </dl>}
      </article>
      <article className="card summary-wide" aria-labelledby="summary-words">
        <div className="card-head"><h2 id="summary-words">Palabras más usadas</h2>
          <div className="segmented" role="group" aria-label="Origen">{([['notes', 'Notas'], ['questions', `Preguntas a ${assistant}`], ['hermes', 'Chats con Hermes']] as const).map(([key, label]) =>
            <button key={key} aria-pressed={words === key} onClick={() => setWords(key)}>{label}</button>)}</div></div>
        {words === 'notes' ? <Words words={core?.noteWords ?? []} empty="Sin notas indexadas."/>
          : words === 'questions' ? <Words words={core?.watson.words ?? []} empty="Aún no hay preguntas."/>
          : <Words words={hermes?.words ?? []} empty="Sin mensajes tuyos en Hermes en 30 días."/>}
        <small className="muted">{words === 'hermes' ? `Tus mensajes de los últimos ${hermes?.days ?? 30} días (${hermes?.messagesCounted ?? 0}), contados en este Mac; solo se guardan los recuentos.` : words === 'notes' && discreet ? 'Modo discreto: solo notas normales.' : 'Sin palabras vacías ni cadenas con pinta de clave.'}</small>
      </article>
      {centralOn && <CentralCard discreet={discreet}/>}
      {moduleOn(modules, 'trabajos') && <ClientsFollowCard discreet={discreet} onOpen={onOpen}/>}
      {moduleOn(modules, 'trabajos') && centralOn && moduleOn(modules, 'crmdev') && <CrmdevPendingCard onOpen={onOpen}/>}
    </div>
  </section>;
}
