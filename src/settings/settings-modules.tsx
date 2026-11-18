import { useState } from 'react';
import type { ModuleName } from '../api/core';
import { LoadError } from '../ui/load-state';
import { refreshOrcaProjects } from '../orca/orca-projects';
import { moduleLabels, moduleOn, setModule, useModules } from '../shell/modules';

const order: ModuleName[] = ['correo', 'agenda', 'fiscal', 'trabajos', 'reuniones', 'voz', 'musica', 'oficina', 'conectores', 'orca', 'whatsapp'];
const meaning: Record<ModuleName, string> = {
  correo: 'deja de leer el correo y de resumirlo; Watson no ve la Bandeja', agenda: 'sin agenda en Hoy; Watson no consulta el calendario',
  fiscal: 'oculta Fiscal', trabajos: 'oculta Trabajos y deja de leer Central', reuniones: 'oculta Reuniones y la tarjeta de grabar',
  voz: 'sin micrófonos para dictar ni hablar con Watson', musica: 'sin tarjeta de música', oficina: 'oculta la Oficina 3D', conectores: 'oculta Conectores',
  orca: 'sin botones para llevar encargos a un agente en Orca', whatsapp: 'deja de leer WhatsApp por Zernio',
};

/** Turning modules off (1.6, C-02): one that is off disappears, stops its background work and Watson loses its
 * tools; its data stays, for when it is turned on again. */
export function ModulesSettingsCard() {
  const modules = useModules();
  const [error, setError] = useState('');
  const labels = moduleLabels();
  const change = async (name: ModuleName, value: boolean) => {
    setError('');
    try { await setModule(name, value); if (name === 'orca') refreshOrcaProjects(value); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <article className="card" aria-labelledby="modules-title">
    <div className="card-head"><h2 id="modules-title">Módulos</h2></div>
    <p>Apaga lo que no uses. Un módulo apagado desaparece de la pantalla, deja de trabajar en segundo plano y Watson pierde sus herramientas; sus datos se conservan para cuando lo vuelvas a encender.</p>
    <ul className="install-list">{order.map(name => <li key={name} className="install-row">
      <label className="check"><input type="checkbox" checked={moduleOn(modules, name)} onChange={event => void change(name, event.target.checked)}/> {labels[name] ?? name}</label>
      <small className="muted">Apagado: {meaning[name]}.</small>
    </li>)}</ul>
    {error && <LoadError message={error}/>}
  </article>;
}
