import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ApiError, getStatus, type Status } from '../api/client';
import { Office } from '../app';
import { Loading } from '../ui/load-state';
import { NoteReader, type NoteRef } from '../brain/note-reader';
import { ShellNav } from './shell-nav';
import { PendingView } from './pending-view';
import { readShell, writeShell, type Section } from './shell-state';
import './shell.css';
import './page.css';

const BrainView = lazy(() => import('../brain/brain-view').then(module => ({ default: module.BrainView })));
const AssistantView = lazy(() => import('../assistant/assistant-view').then(module => ({ default: module.AssistantView })));
const ConnectorsView = lazy(() => import('../connectors/connectors-view').then(module => ({ default: module.ConnectorsView })));
const SettingsView = lazy(() => import('../settings/settings-view').then(module => ({ default: module.SettingsView })));

/** AgoraOne's frame: the rail with the sections and the section on screen. The office (the city) stays
 * mounted once visited so its chats keep going; everything else mounts only while shown. */
export function Shell() {
  const [status, setStatus] = useState<Status | null>(null);
  const [{ section, discreet }, setShell] = useState(readShell);
  const [officeVisited, setOfficeVisited] = useState(section === 'office');
  // A question typed on the brain's page, handed to the assistant once.
  const [question, setQuestion] = useState<string | null>(null);
  // Notes to point out on the graph (the sources of an answer).
  const [focus, setFocus] = useState<string[]>([]);
  const [reading, setReading] = useState<NoteRef | null>(null);
  useEffect(() => {
    getStatus().then(setStatus).catch(error => setStatus(error instanceof ApiError && error.status === 401
      ? { state: 'locked', csrf: '', detail: error.message } : { state: 'offline', csrf: '', detail: 'Backend sin conexión. Arráncalo con npm run dev.' }));
  }, []);
  useEffect(() => writeShell({ section, discreet }), [section, discreet]);
  const go = useCallback((next: Section) => { if (next === 'office') setOfficeVisited(true); setShell(previous => ({ ...previous, section: next })); }, []);
  const setDiscreet = (on: boolean) => setShell(previous => ({ ...previous, discreet: on }));
  const ask = (text: string) => { setQuestion(text); go('assistant'); };
  const showOnGraph = (ids: string[]) => { setFocus(ids); go('brain'); };
  const ready = status?.csrf;
  return <div className="shell">
    <ShellNav section={section} onSection={go} discreet={discreet} onDiscreet={setDiscreet}/>
    <div className="shell-content">
      {officeVisited && ready && <Office status={status} active={section === 'office'}/>}
      {ready && section !== 'office' && <main className="shell-page"><Suspense fallback={<div className="page"><Loading label="Cargando la sección"/></div>}>
        {section === 'brain' ? <BrainView discreet={discreet} focus={focus} onFocus={setFocus} onAsk={ask} onRead={setReading}/>
          : section === 'assistant' ? <AssistantView question={question} onQuestionTaken={() => setQuestion(null)} onRead={setReading} onShowOnGraph={showOnGraph}/>
          : section === 'connectors' ? <ConnectorsView/>
          : section === 'settings' ? <SettingsView/>
          : <PendingView section={section}/>}
      </Suspense></main>}
      {status?.state === 'offline' && <section className="page" role="alert"><h1>Sin conexión</h1><p>{status.detail}</p></section>}
      {!status && <div className="page"><Loading label="Conectando con AgoraOne"/></div>}
      {status?.state === 'locked' && <section className="access-lock" role="alertdialog" aria-label="Acceso a AgoraOne">
        <h2>Falta el enlace de acceso</h2>
        <p>Para que ninguna otra app ni otro usuario de este ordenador pueda usar AgoraOne con tus credenciales, la primera vez hay que entrar con un enlace privado. Después este navegador lo recuerda.</p>
        <p>Ábrelo desde la terminal: <code>npm run dev</code> lo muestra al arrancar («Abre AgoraOne con este enlace…»), o ejecuta <code>npm run open</code>.</p>
      </section>}
    </div>
    {reading && <NoteReader note={reading} onClose={() => setReading(null)}/>}
  </div>;
}
