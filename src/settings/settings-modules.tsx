import { useEffect, useState } from 'react';
import { getConnectors, type Connector, type ModuleName } from '../api/core';
import { LoadError } from '../ui/load-state';
import { refreshOrcaProjects } from '../orca/orca-projects';
import { moduleLabels, moduleOn, setModule, useModules } from '../shell/modules';
import type { Section } from '../shell/shell-state';

const order: ModuleName[] = ['correo', 'agenda', 'fiscal', 'trabajos', 'presupuestos', 'reuniones', 'voz', 'musica', 'oficina', 'orca', 'whatsapp', 'jev', 'central', 'fabrica'];
// What turning off each internal module does; the modules of a connector say it on their card in Conectores.
const meaning: Partial<Record<ModuleName, string>> = {
  correo: 'deja de leer el correo y de resumirlo; Watson no ve la Bandeja', agenda: 'sin agenda en Hoy; Watson no consulta el calendario',
  fiscal: 'oculta Fiscal', trabajos: 'oculta Trabajos (tareas de Hermes y proyectos)', reuniones: 'oculta Reuniones y la tarjeta de grabar',
  voz: 'sin micrófonos para dictar ni hablar con Watson', musica: 'sin tarjeta de música', oficina: 'oculta la Oficina 3D',
  orca: 'sin botones para llevar encargos a un agente en Orca', whatsapp: 'deja de leer WhatsApp por Zernio',
  jev: 'AgoraOne no pregunta nada a Jev y todo sigue con la lógica de siempre',
};

/** The modules that belong to a connector, as its manifest says (never a list repeated here). */
export const connectorModules = (connectors: Pick<Connector, 'modules'>[]) => new Set(connectors.flatMap(connector => Object.keys(connector.modules)));

/** «Central, Presupuestos y Mi fábrica»: the names of the connectors' modules, joined in Spanish. */
export function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

type ListProps = {
  modules: Partial<Record<ModuleName, boolean>>; labels: Partial<Record<ModuleName, string>>; external: Set<string> | null;
  onChange: (name: ModuleName, value: boolean) => void; onConnectors?: () => void;
};

/** The internal modules with their switch, and a line leading to Conectores for the rest. Until the connectors are
 * known, every module is listed, so nothing is ever left without a switch. */
export function ModulesList({ modules, labels, external, onChange, onConnectors }: ListProps) {
  const internal = order.filter(name => !external?.has(name));
  const moved = [...(external ?? [])].map(name => labels[name as ModuleName] ?? name);
  return <>
    <ul className="install-list">{internal.map(name => <li key={name} className="install-row">
      <label className="check"><input type="checkbox" checked={moduleOn(modules, name)} onChange={event => onChange(name, event.target.checked)}/> {labels[name] ?? name}</label>
      <small className="muted">{meaning[name] ? `Apagado: ${meaning[name]}.` : ''}</small>
    </li>)}</ul>
    {moved.length > 0 && <div className="field-row modules-connectors">
      <p>{joinNames(moved)} se encienden y apagan en su tarjeta de Conectores.</p>
      {onConnectors && <span className="actions"><button type="button" className="button" onClick={onConnectors}>Ir a Conectores</button></span>}
    </div>}
  </>;
}

/** Turning modules off (1.6, C-02): one that is off disappears, stops its background work and Watson loses its
 * tools; its data stays, for when it is turned on again. */
export function ModulesSettingsCard({ onOpen }: { onOpen?: (section: Section) => void }) {
  const modules = useModules();
  const [external, setExternal] = useState<Set<string> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    getConnectors().then(data => { if (live) setExternal(connectorModules(data.connectors)); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const change = async (name: ModuleName, value: boolean) => {
    setError('');
    try { await setModule(name, value); if (name === 'orca') refreshOrcaProjects(value); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  return <article className="card" aria-labelledby="modules-title">
    <div className="card-head"><h2 id="modules-title">Módulos</h2></div>
    <p>Apaga lo que no uses. Un módulo apagado desaparece de la pantalla, deja de trabajar en segundo plano y Watson pierde sus herramientas; sus datos se conservan para cuando lo vuelvas a encender.</p>
    <ModulesList modules={modules} labels={moduleLabels()} external={external} onChange={(name, value) => void change(name, value)}
      onConnectors={onOpen ? () => onOpen('connectors') : undefined}/>
    {error && <LoadError message={error}/>}
  </article>;
}
