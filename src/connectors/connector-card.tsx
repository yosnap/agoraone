import { useEffect, useRef, useState } from 'react';
import { testConnector, type Connector, type ConnectorKind, type ConnectorStatus, type ModuleName } from '../api/core';
import type { Section } from '../shell/shell-state';
import { LoadError } from '../ui/load-state';
import { forgetConnector, saveConnector, switchModule } from './connector-actions';
import { canSave, canTest, ConnectorForm, hasSaved, initialFields, typedFor, type Fields } from './connector-forms';
import { extras } from './connector-extras';
import { moduleLabel, moduleMeaning } from './module-meaning';
import { ActionButton } from '../ui/action-button';

// One card per connector, with the same skeleton for all: name and status, what it is, how it connects, the form of
// its kind, «Probar», «Guardar» and «Olvidar…» (confirmed in place) and the switches of its modules. Notices are told
// by their background and text colour, never by a side stripe.

export const statusText: Record<ConnectorStatus, [string, '' | 'good' | 'warn' | 'bad']> = {
  not_configured: ['Sin configurar', ''], not_found: ['No encontrado', 'bad'], unreadable: ['No se puede leer', 'bad'],
  detected: ['Detectado', 'warn'], responding: ['En marcha · responde', 'good'], recording: ['Registrando consumo', 'good'],
  legacy: ['Hay que volver a conectarlo', 'warn'], saved: ['Dirección y clave guardadas', 'good'], failing: ['No responde', 'bad'], guide: ['Guía', ''],
};

export const howText: Record<ConnectorKind, string> = {
  web_api: 'Con su dirección y una clave de acceso. La clave se guarda solo en el almacén de secretos del sistema y no se vuelve a mostrar. Fuera de este equipo solo se admite https; en este ordenador vale http://localhost.',
  local_port: 'En este equipo: AgoraOne reconoce su carpeta y comprueba si su panel responde en el puerto indicado de 127.0.0.1.',
  local_file: 'En este equipo: AgoraOne lee su archivo de datos en solo lectura.',
  guide: 'No hay nada que conectar: se configura a mano siguiendo estas órdenes.',
};

const forgetText: Record<ConnectorKind, string> = {
  web_api: 'Se borra la clave del almacén de secretos; la dirección y los datos ya leídos se conservan.',
  local_port: 'Se olvidan la carpeta y el puerto guardados; no se toca nada en tu equipo.',
  local_file: 'Se olvida la ruta del archivo; no se toca el archivo.',
  guide: '',
};

type ForgetProps = { confirming: boolean; busy: boolean; text: string; onAsk: () => void; onConfirm: () => void; onCancel: () => void };

/** «Olvidar…» asks first, in place, saying exactly what is forgotten. */
export function ForgetAction({ confirming, busy, text, onAsk, onConfirm, onCancel }: ForgetProps) {
  if (!confirming) return <ActionButton icon="trash" label="Olvidar…" tone="danger" disabled={busy} onClick={onAsk}/>;
  return <span className="field-row connector-forget" role="group" aria-label="Confirmar olvidar la conexión">
    <small>{text}</small>
    <ActionButton icon="trash" label="Olvidar de verdad" tone="danger" disabled={busy} onClick={onConfirm}/>
    <ActionButton icon="close" label="Cancelar" onClick={onCancel}/>
  </span>;
}

type SwitchesProps = {
  connector: Connector; modules: Partial<Record<ModuleName, boolean>>; labels: Partial<Record<ModuleName, string>>;
  onToggle: (name: ModuleName, value: boolean) => void;
};

/** The switches of the connector's modules, with what turning each one off does. Labels have a readable fallback
 * (the connector's name for its own module) until the core's arrive. */
export function ModuleSwitches({ connector, modules, labels, onToggle }: SwitchesProps) {
  const switches = Object.keys(connector.modules) as ModuleName[];
  if (!switches.length) return null;
  return <ul className="install-list connector-modules" aria-label={`Módulos de ${connector.name}`}>{switches.map(name =>
    <li key={name} className="install-row">
      <label className="check"><input type="checkbox" checked={(modules[name] ?? connector.modules[name]) !== false}
        onChange={event => onToggle(name, event.target.checked)}/> {moduleLabel(name, labels, name === connector.id ? connector.name : undefined)}</label>
      <small className="muted">Apagado: {moduleMeaning[name] ?? 'desaparece de la pantalla y deja de trabajar en segundo plano'}.</small>
    </li>)}</ul>;
}

type CardProps = {
  connector: Connector; modules: Partial<Record<ModuleName, boolean>>; labels: Partial<Record<ModuleName, string>>;
  focused?: boolean; onSaved: (connector: Connector) => void; onOpen: (section: Section) => void;
};

export function ConnectorCard({ connector, modules, labels, focused = false, onSaved, onOpen }: CardProps) {
  const [fields, setFields] = useState<Fields>(() => initialFields(connector));
  const [busy, setBusy] = useState<'save' | 'test' | 'forget' | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [tested, setTested] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [ring, setRing] = useState(focused);
  const card = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) { card.current?.scrollIntoView({ block: 'start' }); card.current?.focus(); } }, [focused]);
  // What is saved changed (another card, «Comprobar de nuevo», a save): the form shows it again.
  const saved = JSON.stringify(connector.state.configured);
  useEffect(() => { setFields(initialFields(connector)); }, [saved]);  // only when the saved settings change
  const extra = extras[connector.id] ?? {};
  // A «Probar» result belongs to what was typed then: any change makes it stale.
  const set = (changes: Partial<Fields>) => { setTested(null); setFields(current => ({ ...current, ...changes })); };
  const run = async (name: 'save' | 'test' | 'forget', work: () => Promise<string>) => {
    setBusy(name); setError(''); setNote('');
    try { setNote(await work()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); }
    finally { setBusy(null); }
  };
  const changed = (next: Connector) => { setTested(null); onSaved(next); setFields(initialFields(next)); };  // the typed key never stays on screen
  const save = () => void run('save', async () => { const done = await saveConnector(connector, fields); changed(done.next); return done.note; });
  const test = () => void run('test', async () => {
    const found = await testConnector<{ version?: string | null; runtime?: string | null; status?: ConnectorStatus }>(connector.id, typedFor(connector.kind, fields));
    setTested(found);
    if (found.status) return `Con estos datos: ${statusText[found.status]?.[0] ?? found.status}.`;
    return `${connector.name}${found.version ? ` ${found.version}` : ''} responde${found.runtime === 'local' ? ' (en este equipo)' : ''}.`;
  });
  const forget = () => void run('forget', async () => { setForgetting(false); const done = await forgetConnector(connector); changed(done.next); return done.note; });
  const toggle = (name: ModuleName, value: boolean) => {
    setError('');
    switchModule(name, value).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'));
  };
  const [label, tone] = statusText[connector.state.status] ?? [connector.state.status, ''];
  const { notice, storeProblem } = connector.state;
  const Body = extra.Body;
  const actions = <span className="actions connector-actions">
    <ActionButton icon="play" label="Probar" busyLabel={busy === 'test' && 'Probando…'} disabled={!canTest(connector, fields) || busy !== null} onClick={test}/>
    <ActionButton icon="save" label="Guardar" tone="primary" busyLabel={busy === 'save' && 'Guardando…'} type="submit" disabled={!canSave(connector, fields) || busy !== null}/>
    {hasSaved(connector) && <ForgetAction confirming={forgetting} busy={busy !== null} text={forgetText[connector.kind]}
      onAsk={() => setForgetting(true)} onConfirm={forget} onCancel={() => setForgetting(false)}/>}
  </span>;
  return <article ref={card} tabIndex={-1} className={`card connector-card${ring ? ' focused' : ''}`} aria-labelledby={`connector-${connector.id}`}
    data-connector={connector.id} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRing(false); }}>
    <div className="card-head"><h2 id={`connector-${connector.id}`}>{connector.name}</h2><span className={`status-badge ${tone === 'warn' ? 'waiting' : tone || 'neutral'}`}>{label}</span></div>
    <p>{connector.description}</p>
    <p className="connector-how"><strong>Cómo se conecta.</strong> {howText[connector.kind]}</p>
    {notice && <p className="notice" role="status">{notice}</p>}
    {storeProblem && <p className="fiscal-warning" role="alert">{storeProblem}</p>}
    <ConnectorForm connector={connector} fields={fields} set={set} keyPlaceholder={extra.keyPlaceholder} actions={actions} onSubmit={save}/>
    {Body && <Body connector={connector} tested={tested} onOpen={onOpen}/>}
    <ModuleSwitches connector={connector} modules={modules} labels={labels} onToggle={toggle}/>
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
