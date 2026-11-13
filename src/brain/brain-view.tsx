import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { AssistantView, type Thinking } from '../assistant/assistant-view';
import { getBrainGraph, levelLabels, searchBrain, type BrainGraph, type SearchResult } from '../api/core';
import { Loading, LoadError } from '../ui/load-state';
import { layoutGraph } from './graph-layout';
import type { NoteRef } from './note-reader';
import './brain.css';

// three.js and its helpers load only when the graph is shown.
const BrainGraphScene = lazy(() => import('./brain-graph'));

// Distinct colours for the top folders, largest first; the rest share a neutral tone.
const graphPalette = ['#b0564f', '#4f7192', '#7b6290', '#5f8a7d', '#c2913a', '#8c79b8', '#a8605e', '#3f8f9a', '#8f9a5a', '#b0784f', '#5a6fb0', '#9a5a86'];

// Watson's real stages, in order; searching and reading may repeat while it thinks.
const steps = [['recuerda', 'Recuerda'], ['busca', 'Busca'], ['lee', 'Lee'], ['piensa', 'Piensa'], ['responde', 'Responde']] as const;
const order: string[] = ['recuerda', 'piensa', 'busca', 'lee', 'responde'];
const stepState = (current: string | null, step: string) => current === step ? 'now' : current && order.indexOf(step) < order.indexOf(current) ? 'done' : '';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The start page: every indexed note as a graph with a floating explorer, and Watson beside it; the notes an
 * answer uses light up on the graph as they arrive. */
export function BrainView({ discreet, focus, onFocus, onRead }: {
  discreet: boolean; focus: string[]; onFocus: (ids: string[]) => void; onRead: (note: NoteRef) => void;
}) {
  const [explorer, setExplorer] = useState(true);
  const [thinking, setThinking] = useState<Thinking>(null);
  const [near, setNear] = useState(true);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    getBrainGraph(discreet, near).then(data => { if (live) setGraph(data); })
      .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'No se pudo leer el cerebro.'); });
    return () => { live = false; };
  }, [discreet, near, version]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setResults(null); setSearchError(''); return; }
    let live = true;
    const timer = setTimeout(() => searchBrain(text).then(data => { if (live) { setResults(data.results); setSearchError(''); } })
      .catch(failure => { if (live) setSearchError(failure instanceof Error ? failure.message : 'No se pudo buscar.'); }), 300);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  // Discreet mode also keeps non-normal notes out of the search results on screen.
  const shown = useMemo(() => results?.filter(result => !discreet || result.confidentiality === 'normal') ?? null, [results, discreet]);
  const positions = useMemo(() => {
    if (!graph) return new Float32Array();
    const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
    return layoutGraph(graph.nodes, graph.edges.map(edge => ({ a: order.get(edge.a)!, b: order.get(edge.b)!, weight: edge.kind === 'link' ? 1 : 0.35 })));
  }, [graph]);
  const lit = useMemo(() => shown ? new Set(shown.map(result => `${result.source}/${result.ref}`)) : focus.length ? new Set(focus) : null, [shown, focus]);
  const read = (id: string) => { const [vault, note] = id.split('/'); onRead({ vault, note }); };
  const links = graph?.edges.filter(edge => edge.kind === 'link').length ?? 0;
  const { folders, colors } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) { const top = node.folder.split('/')[0]; counts.set(top, (counts.get(top) ?? 0) + 1); }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
    return { folders: ranked, colors: new Map(ranked.slice(0, graphPalette.length).map(([folder], rank) => [folder, graphPalette[rank]])) };
  }, [graph]);
  const hubs = useMemo(() => [...(graph?.nodes ?? [])].sort((a, b) => b.degree - a.degree).filter(node => node.degree > 0).slice(0, 8), [graph]);
  const titles = useMemo(() => new Map(graph?.nodes.map(node => [node.id, node]) ?? []), [graph]);
  return <section className="brain" aria-labelledby="brain-title">
    <div className="brain-stage">
      {error ? <div className="brain-message"><LoadError message={error} onRetry={() => setVersion(value => value + 1)}/></div>
        : !graph ? <div className="brain-message"><Loading label="Leyendo el cerebro"/></div>
        : !graph.nodes.length ? <div className="brain-message"><p>{discreet ? 'En modo discreto no hay notas normales que mostrar.' : 'El cerebro aún no tiene notas. AgoraOne indexa tus vaults de Obsidian al arrancar y cada 5 minutos.'}</p></div>
        : <Suspense fallback={<div className="brain-message"><Loading label="Preparando el grafo"/></div>}>
          <BrainGraphScene graph={graph} positions={positions} lit={lit} colors={colors} reading={thinking?.reading ?? null} still={reducedMotion()} onPick={index => read(graph.nodes[index].id)}/>
        </Suspense>}
    </div>
    <div className={`brain-panel${explorer ? '' : ' folded'}`} aria-label="Explorar el cerebro" role="region">
      <button className="brain-fold button" aria-expanded={explorer} onClick={() => setExplorer(!explorer)}>{explorer ? 'Ocultar' : 'Explorar'}</button>
      <div className="eyebrow">CEREBRO{discreet ? ' · MODO DISCRETO' : ''}</div>
      <h1 id="brain-title">Tu cerebro</h1>
      {graph && <p className="brain-stats">{graph.total} notas · {links} enlaces{graph.semantic ? ' · cercanía por significado activa' : near ? ' · cercanía no disponible (sin vectores locales)' : ''}{graph.truncated ? ` · se muestran las ${graph.nodes.length} más recientes` : ''}</p>}
      <label className="brain-search" htmlFor="brain-find">Buscar en el cerebro</label>
      <input id="brain-find" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Palabras o idea…"/>
      <div className="brain-toggles">
        <label><input type="checkbox" checked={near} onChange={event => setNear(event.target.checked)}/> Cercanía por significado</label>
        {focus.length > 0 && !shown && <button className="button" onClick={() => onFocus([])}>Quitar resaltado ({focus.length})</button>}
      </div>
      {searchError && <LoadError message={searchError}/>}
      {shown ? <div className="brain-list" aria-live="polite">
        <h2>{shown.length ? `${shown.length} notas encontradas` : 'Sin resultados'}</h2>
        <ul>{shown.map(result => <li key={`${result.source}/${result.ref}`}><button onClick={() => read(`${result.source}/${result.ref}`)}>
          <strong>{result.title}</strong><small>{result.folder || 'Raíz'}{result.confidentiality !== 'normal' ? ` · ${levelLabels[result.confidentiality]}` : ''}</small>
        </button></li>)}</ul>
      </div> : focus.length > 0 ? <div className="brain-list"><h2>Fuentes de la respuesta</h2>
        <ul>{focus.map(id => <li key={id}><button onClick={() => read(id)}><strong>{titles.get(id)?.title ?? 'Nota no visible ahora'}</strong><small>{titles.get(id)?.folder || ''}</small></button></li>)}</ul>
      </div> : hubs.length > 0 && <div className="brain-list"><h2>Notas más conectadas</h2>
        <ul>{hubs.map(node => <li key={node.id}><button onClick={() => read(node.id)}><strong>{node.title}</strong><small>{node.degree} conexiones · {node.folder || 'Raíz'}</small></button></li>)}</ul>
      </div>}
      {folders.length > 0 && <ul className="brain-legend" aria-label="Colores por carpeta">{folders.slice(0, graphPalette.length).map(([folder, count]) =>
        <li key={folder}><span style={{ background: colors.get(folder) }} aria-hidden="true"/>{folder || 'Raíz'} <small>{count}</small></li>)}</ul>}
    </div>
    {thinking && <div className="brain-thinking" role="status" aria-live="polite">
      <ol>{steps.map(([id, label]) => <li key={id} className={stepState(thinking.stage, id)}>{label}</li>)}</ol>
      <span>{thinking.label}</span>
    </div>}
    <AssistantView embedded onRead={onRead} onSources={onFocus} onThinking={setThinking}/>
  </section>;
}
