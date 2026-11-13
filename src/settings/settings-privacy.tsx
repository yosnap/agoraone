import { useEffect, useState } from 'react';
import { getHermesCatalog } from '../api/client';
import { getFolderRules, getIndexStatus, levelLabels, putFolderRules, type FolderRule, type IndexStatus } from '../api/core';
import { ModernSelect } from '../ui/modern-select';
import { Loading, LoadError } from '../ui/load-state';

/** What the brain holds and the folder rules that make notes «solo en este Mac» or private. */
export function PrivacySettingsCard() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [rules, setRules] = useState<FolderRule[] | null>(null);
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [dirty, setDirty] = useState(false);
  const load = () => {
    setError('');
    Promise.all([getIndexStatus(), getFolderRules()]).then(([index, list]) => { setStatus(index); setRules(list.rules); setDirty(false); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer el índice.'));
  };
  useEffect(() => { load(); getHermesCatalog().then(catalog => setVaults(catalog.vaults ?? [])).catch(() => undefined); }, []);
  const edit = (index: number, change: Partial<FolderRule>) => { setRules(rules!.map((rule, at) => at === index ? { ...rule, ...change } : rule)); setDirty(true); setSaved(''); };
  const save = async () => {
    setError(''); setSaved('');
    const kept = rules!.filter(rule => rule.folder.trim());
    try { const { reclassified } = await putFolderRules(kept); setSaved(`Reglas guardadas. ${reclassified} notas cambiaron de nivel.`); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudieron guardar las reglas.'); }
  };
  const scopes = [{ value: '*', label: 'Todos los vaults' }, ...vaults.map(vault => ({ value: vault.id, label: vault.name }))];
  return <article className="card" aria-labelledby="settings-privacy">
    <h2 id="settings-privacy">Cerebro y confidencialidad</h2>
    {status ? <p>{status.notes} notas en {status.chunks} fragmentos · {status.byConfidentiality.normal ?? 0} normales, {status.byConfidentiality.local_only ?? 0} solo en este Mac, {status.byConfidentiality.private ?? 0} privadas.
      {' '}{status.semanticSearch ? (status.pendingEmbeddings ? `Calculando significado: faltan ${status.pendingEmbeddings} fragmentos.` : 'Búsqueda por significado activa.') : `Búsqueda por significado en pausa${status.semanticProblem ? `: ${status.semanticProblem}` : ''}.`}</p>
      : !error && <Loading label="Leyendo el índice" lines={2}/>}
    <p>Una nota también puede declararlo en sus propiedades con <code>confidencialidad: privado</code> o <code>solo-local</code>; vale siempre el nivel más estricto. Lo «solo en este Mac» nunca va a un modelo externo; lo privado tampoco sale por MCP ni se ve en modo discreto.</p>
    {rules && <>
      {rules.length ? <table className="data-table"><thead><tr><th>Carpeta</th><th>Vault</th><th>Nivel</th><th><span className="visually-hidden">Quitar</span></th></tr></thead>
        <tbody>{rules.map((rule, index) => <tr key={index}>
          <td><input aria-label="Carpeta" className="rule-folder" value={rule.folder} onChange={event => edit(index, { folder: event.target.value })} placeholder="Carpeta/Subcarpeta"/></td>
          <td><ModernSelect value={rule.source} onChange={value => edit(index, { source: value })} options={scopes}/></td>
          <td><ModernSelect value={rule.confidentiality} onChange={value => edit(index, { confidentiality: value as FolderRule['confidentiality'] })}
            options={(['local_only', 'private'] as const).map(level => ({ value: level, label: levelLabels[level] }))}/></td>
          <td><button className="button danger" aria-label={`Quitar la regla de ${rule.folder || 'carpeta vacía'}`} onClick={() => { setRules(rules.filter((_, at) => at !== index)); setDirty(true); }}>×</button></td>
        </tr>)}</tbody></table> : <p className="muted">Sin reglas de carpeta.</p>}
      <div className="actions"><button className="button" onClick={() => { setRules([...rules, { source: '*', folder: '', confidentiality: 'private' }]); setDirty(true); }}>Añadir regla</button>
        <button className="button primary" disabled={!dirty} onClick={() => void save()}>Guardar reglas</button></div>
    </>}
    {saved && <span className="ok-note" role="status">{saved}</span>}{error && <LoadError message={error} onRetry={load}/>}
  </article>;
}
