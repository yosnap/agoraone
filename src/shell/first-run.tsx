import { useRef, useState } from 'react';
import { getFirstRun, putFirstRun } from '../api/core';
import { InstallSettingsCard } from '../settings/settings-install';
import { ModulesSettingsCard } from '../settings/settings-modules';
import type { Section } from './shell-state';
import { isMac, listenShortcut } from '../ui/platform';

// Whether the guide was seen is kept by the core, so it counts in every browser.
// «Ir a Conectores» from the guide only hides it: it is not marked as seen, so it comes back on the next start.
const finish = () => void putFirstRun(true).catch(() => undefined);
export const showFirstRunAgain = () => void putFirstRun(false).then(() => window.location.reload()).catch(() => undefined);

/** The first start, guided (1.6): what is installed and what is missing, which modules to keep, and where the
 * rest is. Shown once per browser; it can be skipped and opened again from Settings › Instalación. */
export function FirstRun({ onOpen }: { onOpen: (section: Section) => void }) {
  const [open, setOpen] = useState(false);
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getFirstRun().then(state => setOpen(!state.done)).catch(() => undefined); }
  const [step, setStep] = useState(0);
  if (!open) return null;
  const close = () => { finish(); setOpen(false); };
  const steps = [
    { title: 'Bienvenido a AgoraOne', body: <>
      <p>AgoraOne es tu cerebro personal en este equipo: tus notas, tu correo, tu agenda, tus reuniones y tus agentes de Hermes, con Watson para preguntar, hablar y pedir cosas. Lo privado no sale del equipo y nada se hace sin que lo confirmes.</p>
      <p>En dos pasos: comprobamos qué tienes instalado y eliges qué módulos quieres.</p></> },
    { title: 'Qué tengo instalado', body: <InstallSettingsCard/> },
    { title: 'Elige tus módulos', body: <ModulesSettingsCard onOpen={section => { setOpen(false); onOpen(section); }}/> },
    { title: 'Listo', body: <>
      <p>Llama a Watson con <strong>{listenShortcut}</strong> desde cualquier app{isMac && ', o activa «Oye Watson» en Ajustes › Voz'}. En el Cerebro tienes Hoy, tus áreas, la grabación de reuniones y la música.</p>
      <p className="muted">Puedes volver a esta guía en Ajustes › Instalación.</p></> },
  ];
  return <div className="first-run" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
    <div className="first-run-panel">
      <div className="first-run-head"><span className="eyebrow">PASO {step + 1} DE {steps.length}</span>
        <button type="button" className="button" onClick={close}>Saltar</button></div>
      <h1 id="first-run-title">{steps[step].title}</h1>
      <div className="first-run-body">{steps[step].body}</div>
      <div className="first-run-foot">
        {step > 0 && <button type="button" className="button" onClick={() => setStep(step - 1)}>Atrás</button>}
        {step < steps.length - 1 ? <button type="button" className="button primary" onClick={() => setStep(step + 1)}>Siguiente</button>
          : <button type="button" className="button primary" onClick={close}>Empezar</button>}
      </div>
    </div>
  </div>;
}
