import { AssistantSettingsCard } from './settings-assistant';
import { PrivacySettingsCard } from './settings-privacy';
import { BackupsCard } from './settings-backups';
import './settings.css';

/** The assistant, the brain's confidentiality and its backups. */
export function SettingsView() {
  return <section className="page" aria-labelledby="settings-title">
    <div className="eyebrow">AJUSTES</div>
    <h1 id="settings-title">Ajustes</h1>
    <p className="page-lead">Todo se guarda en este Mac: los ajustes en la base del cerebro y las claves en el Llavero de macOS.</p>
    <div className="settings-columns">
      <AssistantSettingsCard/>
      <div className="settings-side"><PrivacySettingsCard/><BackupsCard/></div>
    </div>
  </section>;
}
