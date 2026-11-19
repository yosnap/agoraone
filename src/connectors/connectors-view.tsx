import { useCallback, useEffect, useState } from 'react';
import { getConnectors, type Connector } from '../api/core';
import { moduleLabels, useModules } from '../shell/modules';
import type { Section } from '../shell/shell-state';
import { Loading, LoadError } from '../ui/load-state';
import { ConnectorCard } from './connector-card';
import { takeConnectorLink } from './open-connector';
import './connectors.css';
import { ActionButton } from '../ui/action-button';

/** Conectores: the only place where an external module is connected, one card per connector of `GET /connectors`.
 * Always shown (it is not a module); each connector keeps the switch of its own modules. */
export function ConnectorsView({ onOpen }: { onOpen: (section: Section) => void }) {
  const [found, setFound] = useState<Connector[] | null>(null);
  const [error, setError] = useState('');
  const [focused] = useState(takeConnectorLink);
  const modules = useModules();
  const load = useCallback(() => {
    setError('');
    getConnectors().then(data => setFound(data.connectors)).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los conectores.'));
  }, []);
  useEffect(load, [load]);
  const saved = (connector: Connector) => setFound(current => current?.map(item => item.id === connector.id ? connector : item) ?? null);
  return <ConnectorsPage found={found} error={error} focused={focused} modules={modules} labels={moduleLabels()} onReload={load} onSaved={saved} onOpen={onOpen}/>;
}

type PageProps = {
  found: Connector[] | null; error: string; focused: string | null; modules: Parameters<typeof ConnectorCard>[0]['modules'];
  labels: Parameters<typeof ConnectorCard>[0]['labels']; onReload: () => void; onSaved: (connector: Connector) => void; onOpen: (section: Section) => void;
};

/** The page itself, without reading anything (so it can be rendered as it is). */
export function ConnectorsPage({ found, error, focused, modules, labels, onReload, onSaved, onOpen }: PageProps) {
  return <section className="page connectors" aria-labelledby="connectors-title">
    <div className="eyebrow">CONECTORES</div>
    <h1 id="connectors-title">Conectores</h1>
    <p className="page-lead">Tus otras herramientas, conectadas a AgoraOne. Cada una tiene aquí su conexión, «Probar», «Guardar», «Olvidar» y el interruptor de sus módulos. Las direcciones, rutas y puertos se guardan en este equipo y las claves, solo en el almacén de secretos del sistema.</p>
    <div className="actions page-actions"><ActionButton icon="refresh" label="Comprobar de nuevo" onClick={onReload}/></div>
    {error ? <LoadError message={error} onRetry={onReload}/> : !found ? <Loading label="Leyendo los conectores"/> : <div className="connectors-list">
      {found.map(connector => <ConnectorCard key={connector.id} connector={connector} modules={modules} labels={labels}
        focused={focused === connector.id} onSaved={onSaved} onOpen={onOpen}/>)}
    </div>}
  </section>;
}
