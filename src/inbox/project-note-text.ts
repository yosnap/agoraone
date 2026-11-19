/** What a client's mail becomes in the vault: one new note per mail in the client's folder (user's decision,
 * 15/11/2026), named like the user's own notes («Artilabs - Cambios 23-02-2026»). Pure functions. */

const plain = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Characters Obsidian does not accept in a note name (the server refuses them too).
export const unsafe = /[\\/:*?"<>|#^[\]\u0000-\u001f\p{Cf}\u2028\u2029]/gu;
// Company forms left out when matching a client with its folder («Artilabs S.L.» is «Artilabs»).
const FORMS = new Set(['s', 'l', 'u', 'a', 'sl', 'slu', 'sa', 'sau', 'sll', 'scp', 'cb', 'inc', 'ltd', 'llc', 'gmbh']);
const bare = (name: string) => plain(name).split(' ').filter(word => !FORMS.has(word)).join(' ');

/** The folder that holds the clients' project folders: a folder named «Proyectos» under one about clients,
 * else any folder named «Proyectos», else none. */
export function projectsBase(folders: string[]): string | null {
  const named = [...new Set(folders.flatMap(folder => {
    const parts = folder.split('/');
    return parts.flatMap((part, index) => plain(part) === 'proyectos' ? [parts.slice(0, index + 1).join('/')] : []);
  }))];
  return named.find(base => plain(base).includes('client')) ?? named[0] ?? null;
}

/** A folder or note name the vault accepts: NFC, no forbidden characters, no leading dot, at most `bytes` bytes
 * cut on whole characters, and no space left at either end. */
export function vaultName(text: string, bytes = 240): string {
  const clean = text.normalize('NFC').replace(unsafe, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  const encoder = new TextEncoder();
  let out = '';
  for (const char of Array.from(clean)) {
    if (encoder.encode(out + char).length > bytes) break;
    out += char;
  }
  return out.trim();
}

/** The client's folder inside the base: an existing one whose name matches the client's, or a new one. */
export function clientFolder(folders: string[], base: string, client: string): { folder: string; exists: boolean } {
  const wanted = plain(client);
  const children = [...new Set(folders.filter(f => f.startsWith(`${base}/`)).map(f => f.slice(base.length + 1).split('/')[0]))];
  // Only the same name: a similar one may be another client («Foodzinder Web» is not «FoodZinder»).
  const found = children.find(name => plain(name) === wanted) ?? children.find(name => bare(name) !== '' && bare(name) === bare(client));
  const name = found ?? (vaultName(Array.from(client).slice(0, 60).join('')) || 'Cliente');
  return { folder: `${base}/${name}`, exists: Boolean(found) };
}

export const cleanSubject = (subject: string | null) =>
  (subject ?? '').replace(/^\s*((re|rv|fw|fwd|reenviado|respuesta)\s*:\s*)+/i, '').replace(unsafe, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '').slice(0, 60).trim() || 'Correo';

/** The day in the user's own time zone (a mail sent at 00:30 in Madrid is that day, not the day before in UTC). */
const dmy = (iso: string, separator: string) => {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) return `${iso.slice(8, 10)}${separator}${iso.slice(5, 7)}${separator}${iso.slice(0, 4)}`;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(day.getDate())}${separator}${two(day.getMonth() + 1)}${separator}${day.getFullYear()}`;
};

/** A note made from a mail keeps the mail's confidentiality, so the index never hands it to a remote model. */
export function withLevel(content: string, level: 'normal' | 'local_only' | 'private'): string {
  if (level === 'normal') return content;
  return `---\nconfidencialidad: ${level === 'private' ? 'privado' : 'solo-local'}\n---\n${content}`;
}

export function noteTitle(folder: string, subject: string | null, sentAt: string): string {
  return `${folder.split('/').pop()} - ${cleanSubject(subject)} ${dmy(sentAt, '-')}`;
}

/** Where a card's note comes from: a mail, or a WhatsApp conversation (its participant's name, never the number). */
export type NoteSource = { kind?: 'mail' | 'chat'; subject: string | null; sentAt: string; from: { name: string | null; address: string | null };
  summary: string | null; asks?: string[] };

export function noteContent(mail: NoteSource, project: string | null): string {
  const chat = mail.kind === 'chat';
  const who = mail.from.name && mail.from.address ? `${mail.from.name} (${mail.from.address})` : mail.from.name || mail.from.address || 'desconocido';
  const lines = [`# ${cleanSubject(mail.subject)}`, '', `- Fecha: ${dmy(mail.sentAt, '/')}`, `- De: ${who}${chat ? ' (WhatsApp)' : ''}`];
  if (project) lines.push(`- Proyecto: ${project}`);
  lines.push(chat ? '- Conversación de WhatsApp' : `- Correo: «${(mail.subject ?? '(sin asunto)').trim()}»`);
  if (mail.asks?.length) lines.push('', '## Qué piden', ...mail.asks.map(ask => `- ${ask}`));
  lines.push('', '## Resumen', mail.summary?.trim() || '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The attachments of a WhatsApp conversation, only listed by kind and number (user's decision, 19/11/2026): they are
 * not downloaded and no link is kept. `named` gives each kind its words («2 imágenes»). */
export function attachmentsSection(counts: Record<string, number>, named: (kind: string, count: number) => string): string {
  const lines = Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `- ${n} ${named(kind, n)}`);
  return lines.length ? `\n## Adjuntos\nEn la conversación de WhatsApp (no se descargan):\n${lines.join('\n')}\n` : '';
}
