import type { CodingSession } from '../api/core';
import type { Place } from '../data/city';
import { hosts } from '../agents/coding-sessions';
import { Walker, type AgentPose } from './walker';
import { WorldLabel } from './world-label';

const SEATS = 4;  // desks in front of the workshop; more sessions are counted on the sign
const tools = { claude: 'Claude Code', codex: 'Codex' };
const colors = { claude: '#d97757', codex: '#5b8def' };
const states: Record<CodingSession['state'], string> = { working: 'trabajando', tool: 'herramienta o tu permiso', waiting: 'te espera', paused: 'en pausa' };

/** The coding agents of this Mac at the workshop, one desk each: typing while their record says they work, standing
 * arms folded while a tool runs or they wait for you. Nothing here is ambient: no session, no person. */
export function CodingCrew({ place, sessions, onSelect }: { place: Place; sessions: CodingSession[]; onSelect: () => void }) {
  const shown = sessions.slice(0, SEATS);
  return <group position={place.position}>
    {shown.map((session, i) => {
      const x = (i - (shown.length - 1) / 2) * 1.45;
      const pose: AgentPose = session.state === 'working' ? 'desk' : 'wait';
      return <group key={session.id} position={[x, 0, 0]}>
        <Walker color={colors[session.tool]} phase={i * 2.3} selected={false} pose={pose} onSelect={onSelect}/>
        <WorldLabel position={[0, i % 2 ? 2.85 : 2.15, 3]} distanceFactor={25}>{/* staggered: side by side they would overlap */}
          <button className="character-label" title="Dato real del registro de la sesión (sin su contenido)" onClick={onSelect}>
            {tools[session.tool]}{session.project ? ` · ${session.project}` : ''}
            <span className="world-status">{session.host ? `${hosts[session.host]} · ` : ''}{states[session.state]}</span>
          </button>
        </WorldLabel>
      </group>;
    })}
    <WorldLabel position={[0, 3.6, 0]} distanceFactor={28}>
      <span className="activity-chip">{shown.length ? <strong>{sessions.filter(s => s.state === 'working').length} trabajando ahora{sessions.length > SEATS ? ` · ${sessions.length - SEATS} más` : ''}</strong> : 'Ningún agente de código ahora'}</span>
    </WorldLabel>
  </group>;
}
