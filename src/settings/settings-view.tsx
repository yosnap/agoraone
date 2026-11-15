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
import './settings.css';

/** The assistant, mail accounts, the brain's confidentiality and its backups. */
export function SettingsView() {
  return <section className="page" aria-labelledby="settings-title">
    <div className="eyebrow">AJUSTES</div>
    <h1 id="settings-title">Ajustes</h1>
    <p className="page-lead">Todo se guarda en este Mac: los ajustes en la base del cerebro y las claves en el Llavero de macOS.</p>
    <AppearanceCard/>
    <div className="settings-columns">
      <div className="settings-side"><AssistantSettingsCard/><MailSettingsCard/><MailRulesCard/><CalendarsSettingsCard/><AlertsSettingsCard/></div>
      <div className="settings-side"><FiscalSettingsCard/><QontoSettingsCard/><PrivacySettingsCard/><BackupsCard/></div>
    </div>
  </section>;
}
