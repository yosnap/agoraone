/** What a change is, as in the changelogs of the other projects: feature, improvement, fix, security or change. */
export type ChangeKind = 'feature' | 'improvement' | 'fix' | 'security' | 'change';

export type Change = { kind: ChangeKind; title: string; detail?: string; area?: string };

/** One version. `date` is empty while the version is still being prepared. */
export type Release = { version: string; date: string; title: string; summary: string; changes: Change[] };
