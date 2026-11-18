// Which section was open and whether discreet mode was on, per browser. Storage may be unavailable
// (private window, blocked site data): the app then starts on the brain with discreet mode off.

export type Section = 'brain' | 'summary' | 'assistant' | 'office' | 'connectors' | 'settings' | 'inbox' | 'agenda' | 'jobs' | 'meetings' | 'fiscal' | 'agents' | 'central';
export const sections: Section[] = ['brain', 'summary', 'assistant', 'office', 'connectors', 'settings', 'inbox', 'agenda', 'jobs', 'meetings', 'fiscal', 'agents', 'central'];

/** The rail's sections, in order (Ajustes lives apart, at its foot). «Central» is always the last one; Presupuestos
 * will go right before it. */
export const menu: { id: Exclude<Section, 'settings'>; label: string }[] = [
  { id: 'brain', label: 'Cerebro' }, { id: 'summary', label: 'Resumen' }, { id: 'assistant', label: 'Asistente' }, { id: 'agents', label: 'Agentes' },
  { id: 'office', label: 'Oficina 3D' }, { id: 'connectors', label: 'Conectores' }, { id: 'inbox', label: 'Bandeja' }, { id: 'agenda', label: 'Agenda' },
  { id: 'fiscal', label: 'Fiscal' }, { id: 'jobs', label: 'Trabajos' }, { id: 'meetings', label: 'Reuniones' }, { id: 'central', label: 'Central' },
];

const key = 'agora-shell';

// A link may name the section to open (?seccion=oficina), e.g. the browser checks, which start in the city.
const linked: Record<string, Section> = { cerebro: 'brain', resumen: 'summary', asistente: 'assistant', oficina: 'office', conectores: 'connectors', ajustes: 'settings', bandeja: 'inbox', agenda: 'agenda', fiscal: 'fiscal', trabajos: 'jobs', reuniones: 'meetings', agentes: 'agents', central: 'central' };

export function readShell(): { section: Section; discreet: boolean } {
  const fromLink = linked[new URLSearchParams(window.location.search).get('seccion') ?? ''];
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return { section: fromLink ?? (sections.includes(value?.section) ? value.section : 'brain'), discreet: value?.discreet === true };
  } catch { return { section: fromLink ?? 'brain', discreet: false }; }
}

export function writeShell(state: { section: Section; discreet: boolean }) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* not remembered this time */ }
}
