import type { HermesDiscovery } from './hermes-catalog';

export type ProfileContext = {
  id: string; agentId: string; name: string; label: string;
  files: { name: string; content: string; revision: string }[];
};
export class ProfileContextError extends Error {
  constructor() { super('No se puede usar la identidad del perfil. Comprueba que exista y que SOUL/memoria sean legibles y no superen 96 KiB en conjunto.'); }
}
export function profileContext(discovery: HermesDiscovery, id: string): ProfileContext {
  try {
    const { profile, files } = discovery.detail(id);
    if (files.some(file => file.state === 'unavailable')) throw new Error();
    const selected = files.filter(file => file.state === 'available').map(file => ({ name: file.name, content: file.content || '', revision: file.revision! }));
    if (selected.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 96 * 1024) throw new Error();
    return { id, agentId: profile.agentId, name: profile.name, label: profile.label, files: selected };
  } catch { throw new ProfileContextError(); }
}
