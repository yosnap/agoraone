import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './hermes-adapter';

export type Conversation = {
  id: string; owner: string; agent: string; context: string; profileId?: string;
  hermesSessionId: string; messages: Message[];
};

export class Conversations {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  create(owner: string, profile?: { id: string; agentId: string }): Conversation {
    const conversation: Conversation = { id: randomUUID(), owner, agent: 'luma', context: 'library-lobby',
      hermesSessionId: `agora-${randomUUID()}`, messages: [] };
    if (profile) { conversation.profileId = profile.id; conversation.agent = profile.agentId; conversation.context = `profile-chat:${profile.id}`; }
    this.save(conversation);
    return conversation;
  }
  get(id: string, owner: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const file = join(this.directory, `${id}.json`);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Conversation;
    const validBinding = data.profileId
      ? /^profile-[a-f0-9]{24}$/.test(data.profileId) && /^identity-[a-f0-9]{24}$/.test(data.agent) && data.context === `profile-chat:${data.profileId}`
      : data.agent === 'luma' && data.context === 'library-lobby';
    return data.owner === owner && validBinding ? data : null;
  }
  save(data: Conversation) {
    const file = join(this.directory, `${data.id}.json`);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, file);
  }
}
