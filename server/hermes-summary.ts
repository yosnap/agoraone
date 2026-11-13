import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withHermesDatabase } from './hermes-database';

// What the summary needs from Hermes: tokens and cost per profile and per project (the folder or git
// repository a session worked in, by name only) and the words the user writes most. Read only; the text of
// the user's messages is counted here and never leaves this function (user's decision, 13/11/2026).

export type ProjectUsage = { project: string; tokens: number; costUsd: number; sessions: number };
export type ProfileUsage = { profile: string; tokens: number; costUsd: number; sessions: number; lastActivityAt: string | null };
export type WordCount = { word: string; count: number };
export type HermesSummary = {
  readAt: string; days: number;
  profiles: ProfileUsage[]; projects: ProjectUsage[]; words: WordCount[]; messagesCounted: number;
};

const days = 30;
const maxMessages = 5000;
const stopwords = new Set<string>(JSON.parse(readFileSync(new URL('../shared/stopwords.json', import.meta.url), 'utf8')));
// Words only: letters, 4 to 20 of them. Keys, tokens and links (digits, symbols, long runs) never count.
const wordPattern = /\p{L}{4,20}/gu;
const looksLikeKey = /\p{L}{21,}|[A-Za-z]+\d|\d+[A-Za-z]/u;

/** Adds the words of some texts to a tally, with the shared rules (the core's, for notes and questions). */
export function tallyWords(texts: Iterable<string>, counts = new Map<string, number>()) {
  for (const text of texts) {
    for (const piece of text.split(/\s+/)) {
      if (piece.length > 40 || looksLikeKey.test(piece)) continue;
      for (const match of piece.toLocaleLowerCase('es').matchAll(wordPattern)) {
        const word = match[0];
        if (!stopwords.has(word) && !/^(.)\1+$/u.test(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function topWords(counts: Map<string, number>, top = 40): WordCount[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).slice(0, top).map(([word, count]) => ({ word, count }));
}

const projectName = (path: unknown) => typeof path === 'string' && path.trim() ? basename(path.trim().replace(/\/+$/, '')) || null : null;
const iso = (seconds: unknown) => typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

type Read = { profile: string; tokens: number; costUsd: number; sessions: number; last: number | null; projects: Map<string, ProjectUsage>; words: Map<string, number>; messages: number };
const cache = new Map<string, { key: string; value: Read | null }>();
const stamp = (file: string) => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };

function readProfile(root: string, profile: string, home: string, now: number): Read | null {
  const file = join(home, 'state.db');
  const key = [stamp(file), stamp(`${file}-wal`), Math.floor(now / 600_000)].join('|');
  const cached = cache.get(file);
  if (cached?.key === key) return cached.value;
  const value = withHermesDatabase(root, file, (db, columns) => {
    const s = columns('sessions'), m = columns('messages');
    if (!s.has('started_at') || !s.has('id')) return null;
    const since = (now - days * 86_400_000) / 1000;
    const has = (column: string) => s.has(column) ? column : '0';
    const tokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'].map(c => `coalesce(${has(c)}, 0)`).join(' + ');
    const cost = s.has('actual_cost_usd') || s.has('estimated_cost_usd') ? `coalesce(${has('actual_cost_usd')}, ${has('estimated_cost_usd')}, 0)` : '0';
    const where = s.has('git_repo_root') ? "coalesce(nullif(git_repo_root, ''), cwd)" : s.has('cwd') ? 'cwd' : 'NULL';
    const rows = db.prepare(`SELECT ${where} AS place, count(*) AS sessions, sum(${tokens}) AS tokens, sum(${cost}) AS cost, max(${s.has('last_activity_at') ? 'coalesce(last_activity_at, started_at)' : 'started_at'}) AS last
      FROM sessions WHERE started_at > ? GROUP BY place`).all(since);
    const read: Read = { profile, tokens: 0, costUsd: 0, sessions: 0, last: null, projects: new Map(), words: new Map(), messages: 0 };
    for (const row of rows) {
      const used = Number(row.tokens) || 0, spent = Number(row.cost) || 0, count = Number(row.sessions) || 0;
      read.tokens += used; read.costUsd += spent; read.sessions += count;
      if (typeof row.last === 'number') read.last = Math.max(read.last ?? 0, row.last);
      const name = projectName(row.place);
      if (!name) continue;
      const project = read.projects.get(name) ?? { project: name, tokens: 0, costUsd: 0, sessions: 0 };
      project.tokens += used; project.costUsd += spent; project.sessions += count;
      read.projects.set(name, project);
    }
    if (m.has('role') && m.has('content') && m.has('timestamp')) {
      // Only the tally is kept: the text is dropped as soon as it is counted.
      const texts = db.prepare("SELECT content FROM messages WHERE role = 'user' AND timestamp > ? AND typeof(content) = 'text' ORDER BY timestamp DESC LIMIT ?")
        .all(since, maxMessages).map(row => String(row.content).slice(0, 4000));
      tallyWords(texts, read.words);
      read.messages = texts.length;
    }
    return read;
  });
  cache.set(file, { key, value });
  return value;
}

export function readHermesSummary(root: string, profiles: { id: string; name: string; home: string }[], now = Date.now()): HermesSummary {
  const reads = profiles.flatMap(profile => { try { const read = readProfile(root, profile.name, profile.home, now); return read ? [read] : []; } catch { return []; } });
  const projects = new Map<string, ProjectUsage>();
  for (const read of reads) for (const item of read.projects.values()) {
    const total = projects.get(item.project) ?? { project: item.project, tokens: 0, costUsd: 0, sessions: 0 };
    total.tokens += item.tokens; total.costUsd += item.costUsd; total.sessions += item.sessions;
    projects.set(item.project, total);
  }
  const words = new Map<string, number>();
  for (const read of reads) for (const [word, count] of read.words) words.set(word, (words.get(word) ?? 0) + count);
  return {
    readAt: new Date(now).toISOString(), days,
    profiles: reads.map(read => ({ profile: read.profile, tokens: read.tokens, costUsd: Math.round(read.costUsd * 100) / 100, sessions: read.sessions, lastActivityAt: iso(read.last) }))
      .sort((a, b) => b.tokens - a.tokens),
    projects: [...projects.values()].map(item => ({ ...item, costUsd: Math.round(item.costUsd * 100) / 100 })).sort((a, b) => b.tokens - a.tokens).slice(0, 20),
    words: topWords(words), messagesCounted: reads.reduce((sum, read) => sum + read.messages, 0),
  };
}
