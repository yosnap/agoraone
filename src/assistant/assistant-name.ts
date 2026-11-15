import { useSyncExternalStore } from 'react';
import { getAssistantSettings, getPersonas } from '../api/core';

// The chosen character's name (Watson by default), shared by every screen that mentions the assistant and
// refreshed when the character changes in Settings.
let name = 'Watson';
let asked = false;
const listeners = new Set<() => void>();

export function refreshAssistantName() {
  asked = true;
  Promise.all([getPersonas(), getAssistantSettings()]).then(([list, settings]) => {
    const found = list.personas.find(persona => persona.id === settings.persona)?.name;
    if (found && found !== name) { name = found; listeners.forEach(listener => listener()); }
  }).catch(() => undefined);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useAssistantName(): string {
  if (!asked) refreshAssistantName();
  return useSyncExternalStore(subscribe, () => name);
}
