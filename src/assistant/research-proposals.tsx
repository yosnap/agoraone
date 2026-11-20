import { useEffect, useRef, useState } from 'react';
import { getAssistantSettings, getEngines, type ResearchLimits, type ResearchProposal } from '../api/core';

type Shown = { key: number; proposal: ResearchProposal };

/** Researches Watson proposed. Nothing goes to the web until the user presses «Investigar»: the research then runs
 * apart from the conversation (no history, no mail, chats or clients), searches on Anthropic's servers within the
 * caps of Ajustes, reads pages through AgoraOne's own checked reader and proposes the report as a note. */
export function useResearchProposals() {
  const [list, setList] = useState<Shown[]>([]);
  const counter = useRef(0);
  return {
    list,
    add: (proposal: ResearchProposal) => { const key = ++counter.current; setList(all => [...all, { key, proposal }]); },
    close: (key: number) => setList(all => all.filter(p => p.key !== key)),
    clear: () => setList([]),
  };
}

export function ResearchProposals({ state, busy, onInvestigate }: {
  state: ReturnType<typeof useResearchProposals>; busy: boolean; onInvestigate: (proposal: ResearchProposal) => Promise<boolean>;
}) {
  const [limits, setLimits] = useState<ResearchLimits | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  useEffect(() => {
    if (!state.list.length || limits) return;
    getAssistantSettings().then(settings => setLimits(settings.research)).catch(() => undefined);
    getEngines().then(found => setEngine(found.active)).catch(() => undefined);
  }, [state.list.length, limits]);
  if (!state.list.length) return null;
  return <>{state.list.map(({ key, proposal }) => <ResearchCard key={key} id={`research-${key}`} proposal={proposal} limits={limits} engine={engine}
    // Pressed only while Watson is free (the button is disabled otherwise), so the research does start: the card goes.
    busy={busy} onClose={() => state.close(key)} onInvestigate={value => { if (busy) return; state.close(key); void onInvestigate(value); }}/>)}</>;
}

function ResearchCard({ id, proposal, limits, engine, busy, onClose, onInvestigate }: {
  id: string; proposal: ResearchProposal; limits: ResearchLimits | null; engine: string | null; busy: boolean;
  onClose: () => void; onInvestigate: (proposal: ResearchProposal) => void;
}) {
  const [question, setQuestion] = useState(proposal.question);
  const [scope, setScope] = useState(proposal.scope);
  const caps = limits ? `Hasta ${limits.pages} páginas y ${limits.minutes} minutos (se cambia en Ajustes › Asistente).` : '';
  const where = engine === 'compatible' ? 'Tu proveedor compatible no tiene buscador: solo leerá las direcciones que escribas en la pregunta.'
    : engine === 'anthropic-api' ? `Busca con la API de Anthropic, como mucho ${limits?.searches ?? 5} veces: cada búsqueda se cobra aparte (unos 0,01 $), además del texto.`
    : `Busca con tu sesión de Claude Code, dentro de tu plan (unas ${limits?.searches ?? 5} búsquedas: Claude Code no deja contarlas exactas).`;
  return <article className="card note-proposal" aria-label="Investigación propuesta">
    <strong>Investigación propuesta</strong>
    <small>Sale a internet solo al pulsar «Investigar». No ve esta conversación ni tu correo, mensajes o clientes: solo la pregunta, tus notas normales y la web, y solo abre páginas de los resultados de búsqueda o de tu pregunta. Al terminar te propone guardar el informe en «Investigaciones».</small>
    <label htmlFor={`${id}-question`}>Pregunta</label>
    <textarea id={`${id}-question`} value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} rows={3}/>
    <label htmlFor={`${id}-scope`}>Alcance (opcional)</label>
    <input id={`${id}-scope`} value={scope} onChange={event => setScope(event.target.value)} maxLength={1000} placeholder="Fuentes, fechas, idioma…"/>
    <small className="muted">{caps} {where}</small>
    <div className="actions"><button type="button" onClick={onClose}>Descartar</button>
      <button type="button" className="primary" disabled={!question.trim() || busy} title={busy ? 'Watson está respondiendo' : undefined}
        onClick={() => onInvestigate({ question: question.trim(), scope: scope.trim() })}>Investigar</button></div>
  </article>;
}
