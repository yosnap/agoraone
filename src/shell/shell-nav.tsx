import { useState, type ReactNode } from 'react';
import { menu, type Section } from './shell-state';
import { applyTheme, readTheme, themeLabels, type ThemeChoice } from './theme';
import { setSound, useSoundOn } from '../sound/sound';
import { useMeetingRecorder } from '../meetings/meeting-recorder';
import { moduleOn, useModules } from './modules';
import type { ModuleName } from '../api/core';

// The sections that belong to a module that can be turned off (1.6).
const moduleOf: Partial<Record<Section, ModuleName>> = { inbox: 'correo', agenda: 'agenda', fiscal: 'fiscal', jobs: 'trabajos', meetings: 'reuniones', office: 'oficina', connectors: 'conectores', central: 'central' };

const themeOrder: ThemeChoice[] = ['system', 'light', 'dark'];
const themeIcons: Record<ThemeChoice, string> = { system: '◑', light: '☀', dark: '☾' };

type Item = { id: Section; label: string; icon: ReactNode; pending?: boolean };

// No text glyph draws a calendar without being a coloured emoji: a small drawing in the rail's own colour.
const calendarIcon = <svg className="rail-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17.5h2" strokeWidth="2.4"/>
</svg>;

const icons: Record<(typeof menu)[number]['id'], ReactNode> = {
  brain: '◉', summary: '▤', assistant: '✦', agents: '⚇', office: '▦', connectors: '⧉', inbox: '✉', agenda: calendarIcon,
  fiscal: '€', jobs: '☰', meetings: '◎', central: '◈',
};
const main: Item[] = menu.map(item => ({ ...item, icon: icons[item.id] }));
// Planned for later versions: shown so the map is complete, marked as pending and without content.
const later: Item[] = [];

export const sectionLabel = (id: Section) => [...main, ...later, { id: 'settings', label: 'Ajustes' }].find(item => item.id === id)?.label ?? '';

/** The left rail (a bottom bar on phones): the sections, discreet mode and the settings. */
export function ShellNav({ section, onSection, discreet, onDiscreet, waiting }: {
  section: Section; onSection: (section: Section) => void; discreet: boolean; onDiscreet: (on: boolean) => void;
  /** A profile chat in the office waiting for «Permitir», shown while another section is on screen. */
  waiting: string | null;
}) {
  const [theme, setTheme] = useState(readTheme);
  const sound = useSoundOn();
  const recording = useMeetingRecorder().phase === 'recording';
  const modules = useModules();
  const shown = (item: Item) => !moduleOf[item.id] || moduleOn(modules, moduleOf[item.id]!);
  const nextTheme = () => { const next = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]; applyTheme(next); setTheme(next); };
  const button = (item: Item) => <li key={item.id}><button className={`rail-item${item.pending ? ' rail-pending' : ''}`}
    aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)} title={item.pending ? `${item.label}: pendiente` : item.label}>
    <span className="rail-icon" aria-hidden="true">{item.icon}</span><span className="rail-label">{item.label}</span>
    {item.pending && <span className="visually-hidden"> (pendiente)</span>}
    {item.id === 'meetings' && recording && <span className="rail-alert rail-recording" role="status"><span aria-hidden="true">●</span><span className="visually-hidden">: grabando una reunión</span></span>}
    {item.id === 'office' && waiting && section !== 'office' && <span className="rail-alert" role="status"><span aria-hidden="true">●</span><span className="visually-hidden">: {waiting} espera tu permiso</span></span>}
  </button></li>;
  return <nav className="rail" aria-label="Secciones de AgoraOne">
    <a className="rail-brand" href="/" aria-label="AgoraOne">a</a>
    <ul className="rail-list">{main.filter(shown).map(button)}</ul>
    {later.length > 0 && <ul className="rail-list rail-later" aria-label="Próximamente">{later.map(button)}</ul>}
    <div className="rail-foot">
      <button className="rail-item rail-discreet" aria-pressed={discreet} onClick={() => onDiscreet(!discreet)}
        title={discreet ? 'Modo discreto activo: solo se ven las notas normales' : 'Modo discreto: ocultar lo privado y lo solo-local de la pantalla'}>
        <span className="rail-icon" aria-hidden="true">{discreet ? '◐' : '○'}</span><span className="rail-label">Discreto</span>
      </button>
      <button className="rail-item" aria-pressed={sound} onClick={() => setSound(!sound)} title={sound ? 'Sonido activado · pulsa para silenciar' : 'Sonido silenciado · pulsa para activarlo'}>
        <span className="rail-icon" aria-hidden="true">{sound ? '♪' : '♩'}</span><span className="rail-label">{sound ? 'Sonido' : 'Silencio'}</span>
      </button>
      <button className="rail-item" onClick={nextTheme} title={`${themeLabels[theme]} · pulsa para cambiar`} aria-label={`${themeLabels[theme]}. Cambiar tema`}>
        <span className="rail-icon" aria-hidden="true">{themeIcons[theme]}</span><span className="rail-label">Tema</span>
      </button>
      <button className="rail-item" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => onSection('settings')} title="Ajustes">
        <span className="rail-icon" aria-hidden="true">⚙</span><span className="rail-label">Ajustes</span>
      </button>
    </div>
  </nav>;
}
