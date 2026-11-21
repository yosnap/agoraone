import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AssistantSettingsCard } from './settings-assistant';
import { PrivacySettingsCard } from './settings-privacy';
import { BackupsCard } from './settings-backups';
import { MailSettingsCard } from './settings-mail';
import { MailRulesCard } from './settings-mail-rules';
import { WhatsAppSettingsCard } from './settings-whatsapp';
import { JevSettingsCard } from './settings-jev';
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
import { InstallSettingsCard } from './settings-install';
import { ModulesSettingsCard } from './settings-modules';
import { openConnector } from '../connectors/open-connector';
import type { Section } from '../shell/shell-state';
import { isMac, isWindows } from '../ui/platform';
import { ChangelogCard } from '../about/changelog-view';
import { RoadmapCard } from '../about/roadmap-view';
import { LogCard } from './settings-log';
import './settings.css';

type Tab = { id: string; label: string; cards: (onOpen: (section: Section) => void) => ReactNode };
// One tab per area; what belongs together stays together (a mail account and its rules).
const tabs: Tab[] = [
  { id: 'general', label: 'General', cards: () => <AppearanceCard/> },
  { id: 'instalacion', label: 'Instalación', cards: onOpen => <><InstallSettingsCard/><ModulesSettingsCard onOpen={onOpen}/></> },
  { id: 'asistente', label: 'Asistente', cards: () => <AssistantSettingsCard/> },
  { id: 'correo', label: 'Correo', cards: () => <><MailSettingsCard/><MailRulesCard/></> },
  { id: 'whatsapp', label: 'WhatsApp', cards: () => <WhatsAppSettingsCard/> },
  { id: 'jev', label: 'Jev', cards: () => <JevSettingsCard/> },
  { id: 'agenda', label: 'Agenda y avisos', cards: () => <><CalendarsSettingsCard/><AlertsSettingsCard/></> },
  { id: 'fiscal', label: 'Fiscal', cards: () => <><FiscalSettingsCard/><QontoSettingsCard/></> },
  { id: 'trabajos', label: 'Trabajos', cards: () => <JobsSettingsCard/> },
  { id: 'voz', label: 'Voz', cards: () => <><VoiceSettingsCard/><MeetingSettingsCard/><MusicSettingsCard/><AppsSettingsCard/></> },
  { id: 'privacidad', label: 'Privacidad y copias', cards: () => <><PrivacySettingsCard/><BackupsCard/></> },
  { id: 'novedades', label: 'Novedades', cards: () => <ChangelogCard/> },
  { id: 'hoja-de-ruta', label: 'Hoja de ruta', cards: () => <RoadmapCard/> },
  { id: 'registro', label: 'Registro', cards: () => <LogCard/> },
];
const STORED = 'agora.settings.tab';

// Tabs that left Ajustes for a connector card: an old link (?pestana=central) or the tab saved in this browser opens
// Conectores on that card instead.
export const movedTabs: Record<string, string> = { central: 'central' };

/** The tab to show from the link and from this browser, or the connector an old tab moved to. */
export function resolveTab(linked: string | null, stored: string | null): { tab: string; connector: string | null } {
  if (linked && movedTabs[linked]) return { tab: 'general', connector: movedTabs[linked] };
  if (linked && tabs.some(t => t.id === linked)) return { tab: linked, connector: null };
  if (stored && movedTabs[stored]) return { tab: 'general', connector: movedTabs[stored] };
  if (stored && tabs.some(t => t.id === stored)) return { tab: stored, connector: null };
  return { tab: 'general', connector: null };
}

/** Leaves a tab that moved to Conectores: this browser forgets it (back to General) and Conectores opens on its card. */
export function leaveMovedTab(connector: string, onOpen: (section: Section) => void, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try { storage?.setItem(STORED, 'general'); } catch { /* no storage */ }
  openConnector(connector, onOpen);
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function firstTab(): { tab: string; connector: string | null } {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORED); } catch { /* no storage */ }
  return resolveTab(new URLSearchParams(window.location.search).get('pestana'), stored);
}

/** Settings, one tab per area. Everything is kept on this Mac: settings in the brain's database, keys in the Keychain. */
export function SettingsView({ onOpen }: { onOpen: (section: Section) => void }) {
  const [start] = useState(firstTab);
  const [tab, setTab] = useState(start.tab);
  useEffect(() => { if (start.connector) leaveMovedTab(start.connector, onOpen); }, [start, onOpen]);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const choose = (id: string, focus = false) => {
    setTab(id);
    try { localStorage.setItem(STORED, id); } catch { /* no storage */ }
    const url = new URL(window.location.href);
    url.searchParams.set('pestana', id);
    window.history.replaceState(window.history.state, '', url);
    if (focus) buttons.current[id]?.focus();
    buttons.current[id]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });  // the tab row scrolls sideways
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
    <p className="page-lead">Todo se guarda en este equipo: los ajustes en la base del cerebro y las claves en el almacén de secretos del sistema{isMac ? ' (el Llavero en macOS)' : isWindows ? ' (el Administrador de credenciales en Windows)' : ''}.</p>
    <div className="settings-tabs" role="tablist" aria-label="Apartados de Ajustes" onKeyDown={keys}>
      {tabs.map(t => <button key={t.id} id={`settings-tab-${t.id}`} ref={node => { buttons.current[t.id] = node; }} role="tab" type="button"
        aria-selected={t.id === current.id} aria-controls="settings-panel" tabIndex={t.id === current.id ? 0 : -1} onClick={() => choose(t.id)}>{t.label}</button>)}
    </div>
    <div id="settings-panel" className="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`} key={current.id}>
      {current.cards(onOpen)}
    </div>
  </section>;
}
