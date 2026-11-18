import { lazy, Suspense, useCallback, useEffect, useState, useRef } from 'react';
import { ApiError, getStatus, type Status } from '../api/client';
import { Office } from '../app';
import { Loading } from '../ui/load-state';
import { NoteReader, type NoteRef } from '../brain/note-reader';
import { ShellNav } from './shell-nav';
import { PendingView } from './pending-view';
import { InboxView } from '../inbox/inbox-view';
import { FiscalView } from '../fiscal/fiscal-view';
import { AgendaView } from '../calendar/agenda-view';
import { AlertToasts } from './alert-toasts';
import { UploadNotice } from '../fiscal/upload-watch';
import { FirstRun } from './first-run';
import { requestListen } from '../assistant/listen';
import { YouTubeMini } from '../brain/youtube-player';
import { readShell, writeShell, type Section } from './shell-state';
import './shell.css';
import './page.css';

const BrainView = lazy(() => import('../brain/brain-view').then(module => ({ default: module.BrainView })));
const SummaryView = lazy(() => import('../summary/summary-view').then(module => ({ default: module.SummaryView })));
const AssistantView = lazy(() => import('../assistant/assistant-view').then(module => ({ default: module.AssistantView })));
const ConnectorsView = lazy(() => import('../connectors/connectors-view').then(module => ({ default: module.ConnectorsView })));
const JobsView = lazy(() => import('../jobs/jobs-view').then(module => ({ default: module.JobsView })));
const AgentsView = lazy(() => import('../agents/agents-view').then(module => ({ default: module.AgentsView })));
const MeetingsView = lazy(() => import('../meetings/meetings-view').then(module => ({ default: module.MeetingsView })));
const CentralView = lazy(() => import('../central/central-view').then(module => ({ default: module.CentralView })));
const SettingsView = lazy(() => import('../settings/settings-view').then(module => ({ default: module.SettingsView })));

/** AgoraOne's frame: the rail with the sections and the section on screen. The office (the city) stays
 * mounted once visited so its chats keep going; everything else mounts only while shown. */
export function Shell() {
  const [status, setStatus] = useState<Status | null>(null);
  const [{ section, discreet }, setShell] = useState(readShell);
  const [officeVisited, setOfficeVisited] = useState(section === 'office');
  // Notes to point out on the graph (the sources of an answer).
  const [focus, setFocus] = useState<string[]>([]);
  const [reading, setReading] = useState<NoteRef | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  useEffect(() => {
    getStatus().then(setStatus).catch(error => setStatus(error instanceof ApiError && error.status === 401
      ? { state: 'locked', csrf: '', detail: error.message } : { state: 'offline', csrf: '', detail: 'Backend sin conexión. Arráncalo con pnpm dev.' }));
  }, []);
  useEffect(() => writeShell({ section, discreet }), [section, discreet]);
  // ⌃⌥W (from the desktop app) or «Oye Watson»: to the brain, where Watson's microphone starts listening.
  const listening = useRef(false);
  if (!listening.current && typeof window !== 'undefined') {
    listening.current = true;
    window.addEventListener('agora:listen', () => { setShell(previous => ({ ...previous, section: 'brain' })); window.setTimeout(requestListen, 150); });
  }
  const go = useCallback((next: Section) => { if (next === 'office') setOfficeVisited(true); setShell(previous => ({ ...previous, section: next })); }, []);
  const setDiscreet = (on: boolean) => setShell(previous => ({ ...previous, discreet: on }));
  const showOnGraph = (ids: string[]) => { setFocus(ids); go('brain'); };
  const ready = status?.csrf;
  return <div className="shell">
    <ShellNav section={section} onSection={go} discreet={discreet} onDiscreet={setDiscreet} waiting={waiting}/>
    {ready && <AlertToasts discreet={discreet}/>}
    <UploadNotice onOpen={() => go('fiscal')}/>
    <YouTubeMini/>
    {ready && <FirstRun/>}
    <div className="shell-content">
      {officeVisited && ready && <Office status={status} active={section === 'office'} onWaiting={setWaiting} onWatson={() => go('brain')}/>}
      {ready && section !== 'office' && <main className="shell-page"><Suspense fallback={<div className="page"><Loading label="Cargando la sección"/></div>}>
        {section === 'brain' ? <BrainView discreet={discreet} focus={focus} onFocus={setFocus} onRead={setReading} onSummary={() => go('summary')} onOpen={go}/>
          : section === 'summary' ? <SummaryView discreet={discreet} onRead={setReading}/>
          : section === 'assistant' ? <AssistantView onRead={setReading} onShowOnGraph={showOnGraph} discreet={discreet}/>
          : section === 'connectors' ? <ConnectorsView/>
          : section === 'settings' ? <SettingsView/>
          : section === 'inbox' ? <InboxView discreet={discreet}/>
          : section === 'fiscal' ? <FiscalView discreet={discreet}/>
          : section === 'agenda' ? <AgendaView discreet={discreet} onOpen={go}/>
          : section === 'jobs' ? <JobsView discreet={discreet}/>
          : section === 'meetings' ? <MeetingsView discreet={discreet}/>
          : section === 'agents' ? <AgentsView discreet={discreet} onOpen={go}/>
          : section === 'central' ? <CentralView discreet={discreet} onOpen={go}/>
          : <PendingView section={section}/>}
      </Suspense></main>}
      {status?.state === 'offline' && <section className="page" role="alert"><h1>Sin conexión</h1><p>{status.detail}</p></section>}
      {!status && <div className="page"><Loading label="Conectando con AgoraOne"/></div>}
      {status?.state === 'locked' && <section className="access-lock" role="alertdialog" aria-label="Acceso a AgoraOne">
        <h2>Falta el enlace de acceso</h2>
        <p>Para que ninguna otra app ni otro usuario de este ordenador pueda usar AgoraOne con tus credenciales, la primera vez hay que entrar con un enlace privado. Después este navegador lo recuerda.</p>
        <p>Ábrelo desde la terminal: <code>pnpm dev</code> lo muestra al arrancar («Abre AgoraOne con este enlace…»), o ejecuta <code>pnpm open</code>.</p>
      </section>}
    </div>
    {reading && <NoteReader note={reading} onClose={() => setReading(null)}/>}
  </div>;
}
