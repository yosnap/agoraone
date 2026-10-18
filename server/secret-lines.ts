// Lines that look like credentials are hidden whole: in the interface by default and always
// before text reaches the model. Hidden lines are numbered so an edited text can get them back.
const quoteOrBold = String.raw`["'*\x60]*`;
// Words that only ever name a credential: any value after them is hidden.
const strongKey = String.raw`(?<![A-Za-z])(?:api[_ -]?keys?|access[_ -]?keys?|private[_ -]?keys?|secret[_ -]?(?:access[_ -]?)?keys?|(?:auth|access|refresh|bearer)[_ -]?tokens?|authorization|passwords?|passwd|pwd|contraseñas?|credentials?|claves? (?:de api|api|secretas?|privadas?))(?![A-Za-z])${quoteOrBold}\s*[:=]`;
// Everyday words ("Valores clave: honestidad"): hidden only when the value is one opaque token with a digit or symbol.
const weakKey = String.raw`(?<![A-Za-z_])(?:tokens?|claves?|pass|pin|secret|secreto)(?![A-Za-z])${quoteOrBold}\s*[:=]\s*["'\x60]?(?=[^\s"'\x60]*[\d!#$%&()*+./:;<=>?@^_~-])[^\s"'\x60]{6,}["'\x60]?[,;]?\s*$`;
const secretLine = new RegExp([
  strongKey, weakKey,
  String.raw`(?<![A-Za-z])(?:mi |la |tu )?claves? (?:de )?api (?:es|son)\b`,
  String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{12,}`,
  String.raw`\b(?:sk-|sk_live_|ghp_|gho_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_\-]{8,}|\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s@]+@`, // user:password@host
].join('|'), 'i');
// Long opaque strings (keys, hashes): letters and digits with a 20-character run, outside links;
// plain UUIDs and hyphenated slugs or snake_case names stay visible.
const opaque = /(?<![A-Za-z0-9_+=-])(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_+=-]))(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])(?=[A-Za-z0-9_+=-]*[A-Za-z0-9+=]{20})[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/;
const links = /https?:\/\/\S+|\[\[[^\]]*\]\]/g;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const markerPattern = /^\[línea oculta (\d+)\]$/;
export const hiddenMarker = (n: number) => `[línea oculta ${n}]`;
export const isHiddenMarker = (line: string) => markerPattern.test(line.trim());

export class HiddenLineError extends Error {
  constructor() { super('El texto incluye una marca de línea oculta que no existe. Vuelve a cargar el archivo.'); }
}

const keyAtEnd = new RegExp(strongKey + String.raw`\s*$`, 'i');
const isSecret = (line: string) => secretLine.test(line) || opaque.test(line.replace(links, ' '));

/** Replaces every credential-like line (whole PEM blocks, and a value written on the line after its key) with a numbered marker. */
export function maskSecrets(raw: string): { text: string; hidden: string[] } {
  const hidden: string[] = [];
  let pem = false, next = false;
  const lines = raw.replace(controls, '').split('\n').map(line => {
    // Hermes' memory entry separator ends any pending block, so hiding never merges two entries.
    if (line.trim() === '§') { pem = false; next = false; return line; }
    if (/-----BEGIN [A-Z ]+-----/.test(line)) pem = true;
    // A literal marker already in the text is hidden too, so restoring an edit can never confuse it with a secret.
    const secret = pem || next || isSecret(line) || isHiddenMarker(line);
    next = !pem && keyAtEnd.test(line);
    if (/-----END [A-Z ]+-----/.test(line)) pem = false;
    if (!secret) return line;
    hidden.push(line);
    return hiddenMarker(hidden.length);
  });
  return { text: lines.join('\n'), hidden };
}

/** Puts the original lines back where the edited text kept their markers; removed markers delete the line. */
export function restoreSecrets(edited: string, hidden: string[]): string {
  return edited.split('\n').map(line => {
    const match = markerPattern.exec(line.trim());
    if (!match) return line;
    const original = hidden[Number(match[1]) - 1];
    if (original === undefined) throw new HiddenLineError();
    return original;
  }).join('\n');
}

/** Text shown on explicit request: original lines, control characters removed. */
export const revealSecrets = (raw: string) => raw.replace(controls, '');
