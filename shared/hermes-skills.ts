// The real skills of a Hermes profile, as the skills sheet shows them. Opaque ids, no paths.
export type ProfileSkill = { id: string; name: string; category: string; description: string; bytes: number; readable: boolean };
export type ProfileSkillDetail = ProfileSkill & { revision: string; content: string; hidden: number; hiddenChars: number };
