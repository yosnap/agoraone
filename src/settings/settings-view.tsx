import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AssistantSettingsCard } from './settings-assistant';
import { PrivacySettingsCard } from './settings-privacy';
import { BackupsCard } from './settings-backups';
import { MailSettingsCard } from './settings-mail';
import { MailRulesCard } from './settings-mail-rules';
import { FiscalSettingsCard } from './settings-fiscal';
import { AppearanceCard } from './settings-appearance';
import { QontoSettingsCard } from './settings-qonto';
import { CalendarsSettingsCard } from './settings-calendars';
import { AlertsSettingsCard } from './settings-alerts';
import { JobsSettingsCard } from './settings-jobs';
import { VoiceSettingsCard } from './settings-voice';
import { MeetingSettingsCard } from './settings-meetings';
import { AppsSettingsCard } from './settings-apps';
import { MusicSettingsCard } from './settings-music';
import './settings.css';

type Tab = { id: string; label: string; cards: () => ReactNode };
// One tab per area; what belongs together stays together (a mail account and its rules).
const tabs: Tab[] = [
  { id: 'general', label: 'General', cards: () => <AppearanceCard/> },
  { id: 'asistente', label: 'Asistente', cards: () => <AssistantSettingsCard/> },
  { id: 'correo', label: 'Correo', cards: () => <><MailSettingsCard/><MailRulesCard/></> },
  { id: 'agenda', label: 'Agenda y avisos', cards: () => <><CalendarsSettingsCard/><AlertsSettingsCard/></> },
  { id: 'fiscal', label: 'Fiscal', cards: () => <><FiscalSettingsCard/><QontoSettingsCard/></> },
  { id: 'trabajos', label: 'Trabajos', cards: () => <JobsSettingsCard/> },
  { id: 'voz', label: 'Voz', cards: () => <><VoiceSettingsCard/><MeetingSettingsCard/><MusicSettingsCard/><AppsSettingsCard/></> },
  { id: 'privacidad', label: 'Privacidad y copias', cards: () => <><PrivacySettingsCard/><BackupsCard/></> },
];
const STORED = 'agora.settings.tab';

/** The tab a link names (?pestana=correo), else the last one used in this browser, else General. */
function firstTab(): string {
  const linked = new URLSearchParams(window.location.search).get('pestana');
  if (linked && tabs.some(t => t.id === linked)) return linked;
  try { const stored = localStorage.getItem(STORED); if (stored && tabs.some(t => t.id === stored)) return stored; } catch { /* no storage */ }
  return 'general';
}

/** Settings, one tab per area. Everything is kept on this Mac: settings in the brain's database, keys in the Keychain. */
export function SettingsView() {
  const [tab, setTab] = useState(firstTab);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const choose = (id: string, focus = false) => {
    setTab(id);
    try { localStorage.setItem(STORED, id); } catch { /* no storage */ }
    const url = new URL(window.location.href);
    url.searchParams.set('pestana', id);
    window.history.replaceState(window.history.state, '', url);
    if (focus) buttons.current[id]?.focus();
  };
  // Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
  const keys = (event: KeyboardEvent) => {
    const index = tabs.findIndex(t => t.id === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); choose(tabs[next].id, true); }
  };
  const current = tabs.find(t => t.id === tab) ?? tabs[0];
  return <section className="page settings" aria-labelledby="settings-title">
    <div className="eyebrow">AJUSTES</div>
    <h1 id="settings-title">Ajustes</h1>
    <p className="page-lead">Todo se guarda en este Mac: los ajustes en la base del cerebro y las claves en el Llavero de macOS.</p>
    <div className="settings-tabs" role="tablist" aria-label="Apartados de Ajustes" onKeyDown={keys}>
      {tabs.map(t => <button key={t.id} id={`settings-tab-${t.id}`} ref={node => { buttons.current[t.id] = node; }} role="tab" type="button"
        aria-selected={t.id === current.id} aria-controls="settings-panel" tabIndex={t.id === current.id ? 0 : -1} onClick={() => choose(t.id)}>{t.label}</button>)}
    </div>
    <div id="settings-panel" className="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`} key={current.id}>
      {current.cards()}
    </div>
  </section>;
}
