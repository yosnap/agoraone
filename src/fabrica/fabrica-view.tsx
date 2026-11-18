import { useState } from 'react';
import { ApiError } from '../api/client';
import { openFabricaInBrowser, openFabricaWindow, startFabrica, type FabricaPage } from '../api/fabrica';
import type { Section } from '../shell/shell-state';
import { failureText } from '../shell/window-link-notice';
import { Loading, LoadError } from '../ui/load-state';
import { PANEL_PAGES, canStart, fabricaState, freshFabrica, onMac, stateTexts, useFabricaRead, waitUntilRunning } from './fabrica-state';
import './fabrica.css';

type Said = { ok: boolean; text: string; browser?: boolean };

/** One screen of the panel, in the fábrica's window; without the desktop app, in the browser. */
function OpenInFabrica({ page, label }: { page: FabricaPage; label: string }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const open = async (inBrowser: boolean) => {
    setBusy(true); setSaid(null);
    try {
      if (inBrowser) { await openFabricaInBrowser(page); setSaid({ ok: true, text: 'Abierta en tu navegador.' }); }
      else { await openFabricaWindow(page); setSaid({ ok: true, text: 'Abierta en la ventana de la fábrica.' }); }
    } catch (error) {
      const noWindow = error instanceof ApiError && error.data?.status === 'no_window';
      setSaid({ ok: false, text: failureText(error, 'No se pudo abrir la fábrica.'), browser: noWindow });
    } finally { setBusy(false); }
  };
  return <div className="fabrica-open">
    <div className="actions fabrica-actions">
      <button type="button" className="button" disabled={busy} onClick={() => void open(false)}>{busy ? 'Abriendo…' : label}</button>
      {said?.browser && <button type="button" className="button" disabled={busy} onClick={() => void open(true)}>Abrir en el navegador</button>}
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </div>;
}

/** «Arrancar la fábrica» (macOS): asks its own launchd service to start, then checks a few times whether it answers. */
function StartFabrica() {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const start = async () => {
    setBusy(true); setSaid({ ok: true, text: 'Arrancando la fábrica…' });
    try {
      const answer = await startFabrica();
      if (answer.running) setSaid({ ok: true, text: 'Ya estaba en marcha.' });
      else if (await waitUntilRunning()) setSaid({ ok: true, text: 'La fábrica está en marcha.' });
      else setSaid({ ok: false, text: 'macOS la ha arrancado, pero su panel aún no responde. Vuelve a comprobarlo en un momento o mira sus registros en ~/Library/Logs/mi-fabrica.' });
    } catch (error) { setSaid({ ok: false, text: failureText(error, 'No se pudo arrancar la fábrica.') }); }
    finally { setBusy(false); }
  };
  return <div className="fabrica-open">
    <div className="actions fabrica-actions">
      <button type="button" className="button primary" disabled={busy} onClick={() => void start()}>{busy ? 'Arrancando…' : 'Arrancar la fábrica'}</button>
    </div>
    {said && <p className={said.ok ? 'ok-note' : 'error'} role="status">{said.text}</p>}
  </div>;
}

/** The «Mi fábrica» section, the whole width: the fábrica's state and, while it runs, its panel's screens, each in
 * a window of the app over AgoraOne. AgoraOne brings none of its code: what is done there, the panel does. */
export function FabricaView({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  useState(freshFabrica);  // once per visit: nothing read before is shown as current
  const read = useFabricaRead();
  const state = read.addon ? fabricaState(read.addon.status) : null;
  const usable = state === 'running' || state === 'stopped';
  return <section className="page fabrica" aria-labelledby="fabrica-title">
    <div className="eyebrow">MI FÁBRICA{discreet ? ' · MODO DISCRETO' : ''}</div>
    <div className="fabrica-head">
      <h1 id="fabrica-title">Mi fábrica</h1>
      <div className="actions fabrica-actions"><button type="button" className="button" disabled={read.loading} onClick={read.reload}>Volver a comprobar</button></div>
    </div>
    <p className="page-lead">El panel de tu fábrica de contenido tal cual, con su contraseña: aprobar o rechazar corridas, vigilar a la competencia, guardar ideas y cambiar sus ajustes.</p>
    {read.failure ? <LoadError message={read.failure}/>
      : !state ? <Loading label="Comprobando la fábrica" lines={2}/>
      : <div className="fabrica-panel">
        <article className={`card fabrica-state ${state}`}>
          <div className="fabrica-state-head">
            <div><span className="fabrica-badge">{stateTexts[state].label}</span><p>{stateTexts[state].text}</p></div>
            {state === 'running' && !discreet && <OpenInFabrica page="" label="Abrir la fábrica"/>}
            {canStart(state, onMac()) && <StartFabrica/>}
            {(state === 'missing' || state === 'wrong') && <div className="actions fabrica-actions">
              <button type="button" className="button primary" onClick={() => onOpen('connectors')}>Ir a Conectores</button></div>}
          </div>
          {usable && <p className="muted">La primera vez, entra con la contraseña del panel de la fábrica (si no tienes, créala en su carpeta con «fabrica panel-clave»); la sesión dura 8 horas. Los enlaces a otros sitios se abren en tu navegador y los archivos de una corrida se descargan en Descargas, sin sobrescribir.</p>}
        </article>
        {usable && (discreet ? <p className="muted">En modo discreto no se abre la fábrica.</p>
          : <section aria-labelledby="fabrica-pages-title">
            <h2 id="fabrica-pages-title">Pantallas del panel</h2>
            <ul className="fabrica-pages">{PANEL_PAGES.map(p => <li key={p.label} className="card">
              <div><strong>{p.label}</strong><small className="muted">{p.what}</small></div>
              <OpenInFabrica page={p.page} label="Abrir en la ventana"/>
            </li>)}</ul>
          </section>)}
      </div>}
  </section>;
}
