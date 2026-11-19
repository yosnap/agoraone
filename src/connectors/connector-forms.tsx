import type { ReactNode } from 'react';
import type { Connector, ConnectorChanges, ConnectorKind } from '../api/core';

// The form of each kind of connector. A key is typed in a password field, is never shown again and, left empty, the
// saved one stays. The action buttons go after the last field, on its right, never glued to it.

export type Fields = { url: string; key: string; port: string; path: string; dataPath: string };

/** The fields as saved; the key always starts empty (the core only says whether there is one). */
export function initialFields(connector: Pick<Connector, 'state' | 'hint'>): Fields {
  const saved = connector.state.configured;
  return { url: saved.url ?? '', key: '', port: saved.port ? String(saved.port) : '', path: saved.path ?? '', dataPath: saved.dataPath ?? '' };
}

/** What «Guardar» sends: an empty key is left out (the saved one stays); an empty local value forgets it. */
export function changesFor(kind: ConnectorKind, fields: Fields): ConnectorChanges {
  if (kind === 'web_api') return { url: fields.url.trim(), ...(fields.key.trim() ? { key: fields.key.trim() } : {}) };
  if (kind === 'local_port') return { port: fields.port.trim() ? Number(fields.port) : null, path: fields.path.trim() || null };
  if (kind === 'local_file') return { dataPath: fields.dataPath.trim() || null };
  return {};
}

/** What «Probar» sends: only what is typed (empty means «use what is saved»). */
export function typedFor(kind: ConnectorKind, fields: Fields): ConnectorChanges {
  if (kind !== 'web_api') return changesFor(kind, fields);
  return { ...(fields.url.trim() ? { url: fields.url.trim() } : {}), ...(fields.key.trim() ? { key: fields.key.trim() } : {}) };
}

/** Whether something saved is there to forget. */
export function hasSaved(connector: Pick<Connector, 'kind' | 'state'>): boolean {
  const saved = connector.state.configured;
  if (connector.kind === 'web_api') return saved.hasKey === true;
  if (connector.kind === 'local_port') return Boolean(saved.path);
  if (connector.kind === 'local_file') return Boolean(saved.dataPath);
  return false;
}

export function canSave(connector: Pick<Connector, 'kind' | 'state'>, fields: Fields): boolean {
  if (connector.kind === 'web_api') return fields.url.trim().length > 0 && (connector.state.configured.hasKey === true || fields.key.trim().length > 0);
  return connector.kind !== 'guide';
}

export function canTest(connector: Pick<Connector, 'kind' | 'state'>, fields: Fields): boolean {
  if (connector.kind === 'web_api') return canSave(connector, fields);
  return connector.kind !== 'guide';
}

type FormProps = { connector: Connector; fields: Fields; set: (changes: Partial<Fields>) => void; keyPlaceholder?: string; actions: ReactNode };

export function WebApiForm({ connector, fields, set, keyPlaceholder, actions }: FormProps) {
  const hasKey = connector.state.configured.hasKey === true;
  return <>
    <label className="field">Dirección de {connector.name}
      <input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={fields.url} onChange={event => set({ url: event.target.value })}
        placeholder={connector.hint ?? 'https://'}/></label>
    <label className="field">{hasKey ? 'Cambiar la clave (déjala vacía para conservarla)' : 'Clave de acceso'}
      <input type="password" autoComplete="off" spellCheck={false} value={fields.key} onChange={event => set({ key: event.target.value })}
        placeholder={hasKey ? 'Hay una clave guardada' : keyPlaceholder ?? 'Clave de acceso'}/></label>
    {actions}
  </>;
}

/** The folder lets AgoraOne recognise the project; the port is where its panel answers on 127.0.0.1. */
export function LocalPortForm({ fields, set, actions }: FormProps) {
  return <>
    <label className="field">Carpeta del proyecto
      <input value={fields.path} onChange={event => set({ path: event.target.value })} placeholder="/ruta/absoluta" spellCheck={false}/></label>
    <label className="field connector-port">Puerto
      <input value={fields.port} onChange={event => set({ port: event.target.value.replace(/\D/g, '') })} inputMode="numeric" maxLength={5}/></label>
    {actions}
  </>;
}

export function LocalFileForm({ fields, set, actions }: FormProps) {
  return <>
    <label className="field">Archivo de datos
      <input value={fields.dataPath} onChange={event => set({ dataPath: event.target.value })} placeholder="/ruta/absoluta" spellCheck={false}/></label>
    {actions}
  </>;
}

const forms: Partial<Record<ConnectorKind, (props: FormProps) => ReactNode>> = { web_api: WebApiForm, local_port: LocalPortForm, local_file: LocalFileForm };

/** The form of the connector's kind; a guide has none. */
export function ConnectorForm(props: FormProps & { onSubmit: () => void }) {
  const Form = forms[props.connector.kind];
  if (!Form) return null;
  return <form className="field-row connector-form" onSubmit={event => { event.preventDefault(); props.onSubmit(); }}>
    <Form {...props}/>
  </form>;
}
