import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { AssistantView, type Thinking } from '../assistant/assistant-view';
import { SummaryStrip } from '../summary/summary-strip';
import { BrainDock } from './brain-dock';
import { BrainSide } from './brain-side';
import { BrainToday } from './brain-today';
import { BrainAgents } from './brain-agents';
import { getBrainGraph, levelLabels, searchBrain, type BrainGraph, type GraphLayers, type NodeType, type SearchResult } from '../api/core';
import { Loading, LoadError } from '../ui/load-state';
import { layoutGraph } from './graph-layout';
import type { NoteRef } from './note-reader';
import './brain.css';

// three.js and its helpers load only when the graph is shown.
const BrainGraphScene = lazy(() => import('./brain-graph'));

// Distinct colours for the top folders, largest first; the rest share a neutral tone.
const graphPalette = ['#b0564f', '#4f7192', '#7b6290', '#5f8a7d', '#c2913a', '#8c79b8', '#a8605e', '#3f8f9a', '#8f9a5a', '#b0784f', '#5a6fb0', '#9a5a86'];

// Watson's real stages, in order; searching and reading may repeat while it thinks.
const steps = [['recuerda', 'Recuerda'], ['piensa', 'Piensa'], ['busca', 'Busca'], ['lee', 'Lee'], ['responde', 'Responde']] as const;
const order: string[] = ['recuerda', 'piensa', 'busca', 'lee', 'responde'];
const stepState = (current: string | null, step: string) => current === step ? 'now' : current && order.indexOf(step) < order.indexOf(current) ? 'done' : '';

// Entity colours by type (notes keep the colour of their top folder).
export const typeColors: Partial<Record<NodeType, string>> = { person: '#e2bf72', org: '#5fd3e6', project: '#d9708f', amount: '#8fd17a', date: '#b9a6e8', tag: '#f08a4b' };
export const typeLabels: Record<NodeType, string> = { note: 'Nota', person: 'Persona', org: 'Organización', project: 'Proyecto', amount: 'Cifra', date: 'Fecha', tag: 'Etiqueta', folder: 'Carpeta' };
const topFolder = (node: { type: NodeType; folder?: string; id: string }) => node.type === 'folder' ? node.id.split('/').slice(1)[0] ?? '' : (node.folder ?? '').split('/')[0];

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The start page: every indexed note as a graph with a floating explorer, and Watson beside it; the notes an
 * answer uses light up on the graph as they arrive. */
export function BrainView({ discreet, focus, onFocus, onRead, onSummary }: {
  discreet: boolean; focus: string[]; onFocus: (ids: string[]) => void; onRead: (note: NoteRef) => void; onSummary: () => void;
}) {
  const [explorer, setExplorer] = useState(true);
  const [thinking, setThinking] = useState<Thinking>(null);
  // A question from the command bar, handed to Watson's panel (which sends it and then clears it).
  const [question, setQuestion] = useState<string | null>(null);
  // Whether the graph's highlight comes from an area picked at the side (not from Watson's sources).
  const [fromArea, setFromArea] = useState(false);
  const [pickedArea, setPickedArea] = useState<string | null>(null);
  // Pressing an area (at the side or on the graph) lights its notes up; pressing it again lets go.
  const pickArea = (area: string) => {
    const next = pickedArea === area ? null : area;
    setPickedArea(next); setFromArea(next !== null);
    onFocus(next === null ? [] : (graph?.nodes ?? []).filter(node => node.type === 'note' && topFolder(node).trim() === area).map(node => node.id));
  };
  const [near, setNear] = useState(true);
  const [layers, setLayers] = useState<GraphLayers>({ entities: true, tags: true, folders: false });
  const [picked, setPicked] = useState<string | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    getBrainGraph(discreet, near, layers).then(data => { if (live) { setGraph(data); setPicked(null); } })
      .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'No se pudo leer el cerebro.'); });
    return () => { live = false; };
  }, [discreet, near, layers, version]);
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
    return layoutGraph(graph.nodes.map(node => ({ id: node.id, folder: topFolder(node) })), graph.edges.flatMap(edge => {
      const a = order.get(edge.a), b = order.get(edge.b);
      return a === undefined || b === undefined ? [] : [{ a, b, weight: edge.kind === 'link' ? 1 : edge.kind === 'near' ? 0.35 : 0.5 }];
    }));
  }, [graph]);
  // An entity, tag or folder picked on the graph lights up the notes around it.
  const around = useMemo(() => picked && graph ? graph.edges.flatMap(edge => edge.a === picked ? [edge.b] : edge.b === picked ? [edge.a] : []) : [], [picked, graph]);
  const lit = useMemo(() => shown ? new Set(shown.map(result => `${result.source}/${result.ref}`)) : picked ? new Set([picked, ...around])
    : focus.length ? new Set(focus) : null, [shown, focus, picked, around]);
  const read = (id: string) => { const [vault, note] = id.split('/'); onRead({ vault, note }); };
  const pick = (index: number) => { const node = graph!.nodes[index]; if (node.type === 'note') read(node.id); else setPicked(node.id === picked ? null : node.id); };
  const pickedNode = graph?.nodes.find(node => node.id === picked);
  const links = graph?.edges.filter(edge => edge.kind === 'link').length ?? 0;
  const { folders, colors } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) { if (node.type !== 'note') continue; const top = topFolder(node); counts.set(top, (counts.get(top) ?? 0) + 1); }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
    return { folders: ranked, colors: new Map(ranked.slice(0, graphPalette.length).map(([folder], rank) => [folder, graphPalette[rank]])) };
  }, [graph]);
  // Each big area's name at the centre of its notes, as CROW draws its folders.
  const areaLabels = useMemo(() => {
    if (!graph || !positions) return [];
    const sums = new Map<string, [number, number, number, number]>();
    graph.nodes.forEach((node, index) => {
      if (node.type !== 'note') return;
      const area = topFolder(node).trim(), sum = sums.get(area) ?? [0, 0, 0, 0];
      sum[0] += positions[index * 3]; sum[1] += positions[index * 3 + 1]; sum[2] += positions[index * 3 + 2]; sum[3] += 1;
      sums.set(area, sum);
    });
    return [...sums].filter(([, sum]) => sum[3] >= 3).sort((a, b) => b[1][3] - a[1][3]).slice(0, 12)
      .map(([name, sum]) => ({ name, count: sum[3], color: colors.get(name) ?? '#9a93a8', at: [sum[0] / sum[3], sum[1] / sum[3] + 2, sum[2] / sum[3]] as [number, number, number] }));
  }, [graph, positions, colors]);
  const hubs = useMemo(() => [...(graph?.nodes ?? [])].filter(node => node.type === 'note').sort((a, b) => b.degree - a.degree).filter(node => node.degree > 0).slice(0, 8), [graph]);
  const titles = useMemo(() => new Map(graph?.nodes.map(node => [node.id, node]) ?? []), [graph]);
  return <section className="brain" aria-labelledby="brain-title">
    <div className="brain-stage">
      {error ? <div className="brain-message"><LoadError message={error} onRetry={() => setVersion(value => value + 1)}/></div>
        : !graph ? <div className="brain-message"><Loading label="Leyendo el cerebro"/></div>
        : !graph.nodes.length ? <div className="brain-message"><p>{discreet ? 'En modo discreto no hay notas normales que mostrar.' : 'El cerebro aún no tiene notas. AgoraOne indexa tus vaults de Obsidian al arrancar y cada 5 minutos.'}</p></div>
        : <Suspense fallback={<div className="brain-message"><Loading label="Preparando el grafo"/></div>}>
          <BrainGraphScene graph={graph} positions={positions} lit={lit} colors={colors} typeColors={typeColors} reading={thinking?.reading ?? null} still={reducedMotion()} onPick={pick} areas={areaLabels} picked={pickedArea} onArea={pickArea}/>
        </Suspense>}
    </div>
    <div className="brain-panel" aria-label="Explorar el cerebro" role="region">
      <button className="brain-fold button" aria-expanded={explorer} onClick={() => setExplorer(!explorer)}>{explorer ? 'Ocultar' : 'Explorar'}</button>
      <div className="eyebrow">CEREBRO{discreet ? ' · MODO DISCRETO' : ''}</div>
      <h1 id="brain-title">Tu cerebro</h1>
      {graph && <p className="brain-stats">{graph.total} notas · {links} enlaces{graph.semantic ? ' · cercanía por significado activa' : near ? ' · cercanía no disponible (sin vectores locales)' : ''}{graph.truncated ? ` · se muestran las ${graph.nodes.length} más recientes` : ''}</p>}
      <label className="brain-search" htmlFor="brain-find">Buscar en el cerebro</label>
      <input id="brain-find" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Palabras o idea…"/>
      <div className="brain-toggles">
        <label><input type="checkbox" checked={near} onChange={event => setNear(event.target.checked)}/> Cercanía por significado</label>
        <label><input type="checkbox" checked={layers.entities} onChange={event => setLayers({ ...layers, entities: event.target.checked })}/> Entidades</label>
        <label><input type="checkbox" checked={layers.tags} onChange={event => setLayers({ ...layers, tags: event.target.checked })}/> Etiquetas</label>
        <label><input type="checkbox" checked={layers.folders} onChange={event => setLayers({ ...layers, folders: event.target.checked })}/> Carpetas</label>
        {focus.length > 0 && !shown && <button className="button" onClick={() => onFocus([])}>Quitar resaltado ({focus.length})</button>}
      </div>
      {searchError && <LoadError message={searchError}/>}
      {!shown && !pickedNode && <BrainToday discreet={discreet}/>}
      {!shown && !pickedNode && <BrainAgents/>}
      {pickedNode && !shown ? <div className="brain-list" aria-live="polite">
        <h2>{typeLabels[pickedNode.type]}: {pickedNode.title}</h2>
        <ul>{around.flatMap(id => { const node = titles.get(id); return node?.type === 'note' ? [<li key={id}><button onClick={() => read(id)}><strong>{node.title}</strong><small>{node.folder || 'Raíz'}</small></button></li>] : []; })}</ul>
        <button className="button" onClick={() => setPicked(null)}>Quitar selección</button>
      </div> : shown ? <div className="brain-list" aria-live="polite">
        <h2>{shown.length ? `${shown.length} notas encontradas` : 'Sin resultados'}</h2>
        <ul>{shown.map(result => <li key={`${result.source}/${result.ref}`}><button onClick={() => read(`${result.source}/${result.ref}`)}>
          <strong>{result.title}</strong><small>{result.folder || 'Raíz'}{result.confidentiality !== 'normal' ? ` · ${levelLabels[result.confidentiality]}` : ''}</small>
        </button></li>)}</ul>
      </div> : focus.length > 0 && !fromArea ? <div className="brain-list"><h2>Fuentes de la respuesta</h2>
        <ul>{focus.map(id => <li key={id}><button onClick={() => read(id)}><strong>{titles.get(id)?.title ?? 'Nota no visible ahora'}</strong><small>{titles.get(id)?.folder || ''}</small></button></li>)}</ul>
      </div> : <BrainSide discreet={discreet} colors={colors} picked={pickedArea} onPick={pickArea} onRead={read}/>}
      {!shown && !pickedNode && hubs.length > 0 && <details className="brain-hubs"><summary>Notas más conectadas</summary><div className="brain-list">
        <ul>{hubs.map(node => <li key={node.id}><button onClick={() => read(node.id)}><strong>{node.title}</strong><small>{node.degree} conexiones · {node.folder || 'Raíz'}</small></button></li>)}</ul>
      </div></details>}
      {(layers.entities || layers.tags) && <ul className="brain-legend" aria-label="Colores por tipo">{(Object.keys(typeColors) as NodeType[])
        .filter(type => type === 'tag' ? layers.tags : layers.entities).map(type =>
          <li key={type}><span style={{ background: typeColors[type] }} aria-hidden="true"/>{typeLabels[type]}</li>)}</ul>}
      {folders.length > 0 && <ul className="brain-legend" aria-label="Colores por carpeta">{folders.slice(0, graphPalette.length).map(([folder, count]) =>
        <li key={folder}><span style={{ background: colors.get(folder) }} aria-hidden="true"/>{folder || 'Raíz'} <small>{count}</small></li>)}</ul>}
    </div>
    <SummaryStrip discreet={discreet} onOpen={onSummary} tail={graph ? `${graph.total} notas · ${areaLabels.length} áreas · ${links} enlaces` : undefined}/>
    <BrainDock/>
    {thinking && <div className="brain-thinking" role="status" aria-live="polite">
      <ol>{steps.map(([id, label]) => <li key={id} className={stepState(thinking.stage, id)}>{label}</li>)}</ol>
      <span>{thinking.label}</span>
    </div>}
    <AssistantView embedded question={question} onQuestionTaken={() => setQuestion(null)} onRead={onRead} onSources={ids => { setFromArea(false); setPickedArea(null); onFocus(ids); }} onThinking={setThinking} discreet={discreet}/>
  </section>;
}
