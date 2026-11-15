// Which section was open and whether discreet mode was on, per browser. Storage may be unavailable
// (private window, blocked site data): the app then starts on the brain with discreet mode off.

export type Section = 'brain' | 'summary' | 'assistant' | 'office' | 'connectors' | 'settings' | 'inbox' | 'agenda' | 'jobs' | 'meetings' | 'fiscal';
export const sections: Section[] = ['brain', 'summary', 'assistant', 'office', 'connectors', 'settings', 'inbox', 'agenda', 'jobs', 'meetings', 'fiscal'];

const key = 'agora-shell';

// A link may name the section to open (?seccion=oficina), e.g. the browser checks, which start in the city.
const linked: Record<string, Section> = { cerebro: 'brain', resumen: 'summary', asistente: 'assistant', oficina: 'office', conectores: 'connectors', ajustes: 'settings', bandeja: 'inbox', agenda: 'agenda', fiscal: 'fiscal', trabajos: 'jobs' };

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
