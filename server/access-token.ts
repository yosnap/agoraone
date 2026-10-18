import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Access to AgoraOne's API needs a token that only the user can read (a file with mode 0600 in .agora),
// so another user of the Mac, a sandboxed app or a container that reaches 127.0.0.1 cannot use it with
// the user's credentials. The browser trades the token once for an HttpOnly cookie; the CSRF header and
// the Host/Origin checks stay on top of it.
export const accessCookie = 'agora_access';
export const defaultTokenFile = resolve('.agora/access-token');

/** The persistent token: read from its file, or created there the first time. */
export function loadAccessToken(file = defaultTokenFile) {
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(token)) { chmodSync(file, 0o600); return token; }
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** What the cookie holds: a digest of the token, never the token itself. */
export const accessProof = (token: string) => createHash('sha256').update(`agoraone-access:${token}`).digest('hex');

export function sameSecret(given: string | undefined, expected: string) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
