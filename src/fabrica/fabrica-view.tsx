import { useState } from 'react';
import { ApiError } from '../api/client';
import { openConnector } from '../connectors/open-connector';
import { openFabricaInBrowser, openFabricaWindow, startFabrica, type FabricaPage } from '../api/fabrica';
import type { Section } from '../shell/shell-state';
import { failureText } from '../shell/window-link-notice';
import { Loading, LoadError } from '../ui/load-state';
import { PANEL_PAGES, canStart, fabricaState, freshFabrica, onMac, readFabrica, stateLabels, stateText, useFabricaRead, waitUntilRunning,
  type FabricaState } from './fabrica-state';
import './fabrica.css';
import { ActionButton } from '../ui/action-button';

type Said = { ok: boolean; text: string; browser?: boolean };

/** Whether opening failed only because there is no desktop app (AgoraOne in a browser tab): the browser is offered. */
export const noWindow = (error: unknown) => error instanceof ApiError && error.data?.status === 'no_window';

const NOT_ANSWERING = 'La fábrica aún no responde: arráncala primero o vuelve a comprobarlo en un momento.';

/** One screen of the panel, in the fábrica's window; without the desktop app, in the browser. `checkFirst` (the
 * fábrica looked stopped): asks again whether it answers before opening, and says so when it does not. */
function OpenInFabrica({ page, label, checkFirst = false }: { page: FabricaPage; label: string; checkFirst?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const open = async (inBrowser: boolean) => {
    setBusy(true); setSaid(null);
    try {
      if (checkFirst && (await readFabrica(true)).addon?.status !== 'responding') { setSaid({ ok: false, text: NOT_ANSWERING }); return; }
      if (inBrowser) { await openFabricaInBrowser(page); setSaid({ ok: true, text: 'Abierta en tu navegador.' }); }
      else { await openFabricaWindow(page); setSaid({ ok: true, text: 'Abierta en la ventana de la fábrica.' }); }
    } catch (error) {
      setSaid({ ok: false, text: failureText(error, 'No se pudo abrir la fábrica.'), browser: noWindow(error) });
    } finally { setBusy(false); }
  };
  return <OpenButtons label={label} busy={busy} said={said} onOpen={inBrowser => void open(inBrowser)}/>;
}

/** The open button on the right, «Abrir en el navegador» next to it when there is no desktop app, and what happened. */
export function OpenButtons({ label, busy, said, onOpen }: { label: string; busy: boolean; said: Said | null; onOpen: (inBrowser: boolean) => void }) {
  return <div className="fabrica-open">
    <div className="actions fabrica-actions">
      <ActionButton icon="external" label={label} busyLabel={busy && 'Abriendo…'} disabled={busy} onClick={() => onOpen(false)}/>
      {said?.browser && <ActionButton icon="external" label="Abrir en el navegador" disabled={busy} onClick={() => onOpen(true)}/>}
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </div>;
}

/** What the section shows for a known state: the state card and, when the panel may be used, its screens. */
export function FabricaPanel({ state, discreet, mac, starting, started, onStart, onOpen }: {
  state: FabricaState; discreet: boolean; mac: boolean; starting: boolean; started: Said | null;
  onStart: () => void; onOpen: (section: Section) => void;
}) {
  const usable = state === 'running' || state === 'stopped';
  return <div className="fabrica-panel">
    <article className={`card fabrica-state ${state}`}>
      <div className="fabrica-state-head">
        <div><span className="fabrica-badge">{stateLabels[state]}</span><p>{stateText(state, mac, discreet)}</p></div>
        <div className="fabrica-state-actions">
          {canStart(state, mac) && <div className="actions fabrica-actions">
            <ActionButton icon="power" label="Arrancar la fábrica" tone="primary" busyLabel={starting && 'Arrancando…'} disabled={starting} onClick={onStart}/></div>}
          {usable && !discreet && <OpenInFabrica page="" label="Abrir la fábrica" checkFirst={state === 'stopped'}/>}
          {(state === 'missing' || state === 'wrong') && <div className="actions fabrica-actions">
            <ActionButton icon="link" label="Ir a Conectores" tone="primary" onClick={() => openConnector('fabrica', onOpen)}/></div>}
        </div>
      </div>
      {started && <p className={started.ok ? 'ok-note' : 'error'} role="status">{started.text}</p>}
      {usable && <p className="muted">La primera vez, entra con la contraseña del panel de la fábrica (si no tienes, créala en su carpeta con «fabrica panel-clave»); la sesión dura 8 horas. Los enlaces a otros sitios se abren en tu navegador y los archivos de una corrida se descargan en Descargas, sin sobrescribir.</p>}
    </article>
    {usable && (discreet ? <p className="muted">En modo discreto no se abre la fábrica.</p>
      : <section aria-labelledby="fabrica-pages-title">
        <h2 id="fabrica-pages-title">Pantallas del panel</h2>
        <ul className="fabrica-pages">{PANEL_PAGES.map(p => <li key={p.label} className="card">
          <div><strong>{p.label}</strong><small className="muted">{p.what}</small></div>
          <OpenInFabrica page={p.page} label="Abrir en la ventana" checkFirst={state === 'stopped'}/>
        </li>)}</ul>
      </section>)}
  </div>;
}

/** The «Mi fábrica» section, the whole width: the fábrica's state and its panel's screens, each in a window of the
 * app over AgoraOne. AgoraOne brings none of its code: what is done there, the panel does. */
export function FabricaView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  useState(freshFabrica);  // once per visit: nothing read before is shown as current
  const read = useFabricaRead();
  // «Arrancar»'s result lives here, so it stays on screen when the state it changed (or a failed read) changes the card.
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<Said | null>(null);
  const start = async () => {
    setStarting(true); setStarted({ ok: true, text: 'Arrancando la fábrica…' });
    try {
      const answer = await startFabrica();
      if (answer.running) setStarted({ ok: true, text: 'Ya estaba en marcha.' });
      else if (await waitUntilRunning()) setStarted({ ok: true, text: 'La fábrica está en marcha.' });
      else setStarted({ ok: false, text: 'macOS la ha arrancado, pero su panel aún no responde. Vuelve a comprobarlo en un momento o mira sus registros en ~/Library/Logs/mi-fabrica.' });
    } catch (error) { setStarted({ ok: false, text: failureText(error, 'No se pudo arrancar la fábrica.') }); }
    finally { setStarting(false); }
  };
  const state = read.addon ? fabricaState(read.addon.status) : null;
  return <section className="page fabrica" aria-labelledby="fabrica-title">
    <div className="eyebrow">MI FÁBRICA{discreet ? ' · MODO DISCRETO' : ''}</div>
    <div className="fabrica-head">
      <h1 id="fabrica-title">Mi fábrica</h1>
      <div className="actions fabrica-actions"><ActionButton icon="refresh" label="Volver a comprobar" disabled={read.loading} onClick={read.reload}/></div>
    </div>
    <p className="page-lead">El panel de tu fábrica de contenido tal cual, con su contraseña: aprobar o rechazar corridas, vigilar a la competencia, guardar ideas y cambiar sus ajustes.</p>
    {read.failure ? <>
      <LoadError message={read.failure}/>
      {started && <p className={started.ok ? 'ok-note' : 'error'} role="status">{started.text}</p>}
    </>
      : !state ? <Loading label="Comprobando la fábrica" lines={2}/>
      : <FabricaPanel state={state} discreet={discreet} mac={onMac()} starting={starting} started={started} onStart={() => void start()} onOpen={onOpen}/>}
  </section>;
}
