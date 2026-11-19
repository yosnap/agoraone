import { useState } from 'react';
import type { ModuleName } from '../api/core';
import { moduleLabel, moduleMeaning } from '../connectors/module-meaning';
import { Loading, LoadError } from '../ui/load-state';
import { refreshOrcaProjects } from '../orca/orca-projects';
import { moduleLabels, moduleOn, moduleOwners, modulesRead, setModule, useModules } from '../shell/modules';
import type { Section } from '../shell/shell-state';

const order: ModuleName[] = ['correo', 'agenda', 'fiscal', 'trabajos', 'presupuestos', 'reuniones', 'voz', 'musica', 'oficina', 'orca', 'whatsapp', 'jev', 'central', 'fabrica'];
// What turning off each internal module does; the modules of a connector say it on their card in Conectores (and
// here only when an older core does not say which connector holds them).
const meaning: Partial<Record<ModuleName, string>> = {
  correo: 'deja de leer el correo y de resumirlo; Watson no ve la Bandeja', agenda: 'sin agenda en Hoy; Watson no consulta el calendario',
  fiscal: 'oculta Fiscal', trabajos: 'oculta Trabajos (tareas de Hermes y proyectos)', reuniones: 'oculta Reuniones y la tarjeta de grabar',
  voz: 'sin micrófonos para dictar ni hablar con Watson', musica: 'sin tarjeta de música', oficina: 'oculta la Oficina 3D',
  orca: 'sin botones para llevar encargos a un agente en Orca', whatsapp: 'deja de leer WhatsApp por Zernio',
  jev: 'AgoraOne no pregunta nada a Jev y todo sigue con la lógica de siempre', ...moduleMeaning,
};

/** «Central, Presupuestos y Mi fábrica»: the names of the connectors' modules, joined in Spanish. */
export function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

type ListProps = {
  modules: Partial<Record<ModuleName, boolean>>; labels: Partial<Record<ModuleName, string>>;
  /** Module → connector that holds its switch (from `/modules`); null: not said, every module is listed here. */
  owners: Partial<Record<string, string>> | null;
  onChange: (name: ModuleName, value: boolean) => void; onConnectors?: () => void;
};

/** The internal modules with their switch, and a line leading to Conectores for the rest. When the core does not say
 * which connector holds a module, every module is listed with its meaning, so nothing is left without a switch. */
export function ModulesList({ modules, labels, owners, onChange, onConnectors }: ListProps) {
  const internal = order.filter(name => !owners?.[name]);
  const moved = Object.keys(owners ?? {}).map(name => moduleLabel(name, labels));
  return <>
    <ul className="install-list">{internal.map(name => <li key={name} className="install-row">
      <label className="check"><input type="checkbox" checked={moduleOn(modules, name)} onChange={event => onChange(name, event.target.checked)}/> {moduleLabel(name, labels)}</label>
      <small className="muted">{meaning[name] ? `Apagado: ${meaning[name]}.` : ''}</small>
    </li>)}</ul>
    {moved.length > 0 && <div className="field-row modules-connectors">
      <p>{joinNames(moved)} se encienden y apagan en su tarjeta de Conectores.</p>
      {onConnectors && <span className="actions"><button type="button" className="button" onClick={onConnectors}>Ir a Conectores</button></span>}
    </div>}
  </>;
}

/** Turning modules off (1.6, C-02): one that is off disappears, stops its background work and Watson loses its
 * tools; its data stays, for when it is turned on again. Which modules belong to a connector comes with `/modules`,
 * without reading any connection. */
export function ModulesSettingsCard({ onOpen }: { onOpen?: (section: Section) => void }) {
  const modules = useModules();
  const [error, setError] = useState('');
  const change = async (name: ModuleName, value: boolean) => {
    setError('');
    try { await setModule(name, value); if (name === 'orca') refreshOrcaProjects(value); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <article className="card" aria-labelledby="modules-title">
    <div className="card-head"><h2 id="modules-title">Módulos</h2></div>
    <p>Apaga lo que no uses. Un módulo apagado desaparece de la pantalla, deja de trabajar en segundo plano y Watson pierde sus herramientas; sus datos se conservan para cuando lo vuelvas a encender.</p>
    {!modulesRead() ? <Loading label="Leyendo los módulos" lines={4}/>
      : <ModulesList modules={modules} labels={moduleLabels()} owners={moduleOwners()} onChange={(name, value) => void change(name, value)}
        onConnectors={onOpen ? () => onOpen('connectors') : undefined}/>}
    {error && <LoadError message={error}/>}
  </article>;
}
