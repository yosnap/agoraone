import type { CoreLink } from './core-proxy';

export class CoreUnavailable extends Error {}

/** The backend's own calls to the core (e.g. /internal/index/*), with the start secret. JSON in and out. */
export async function coreRequest<T>(link: CoreLink, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, link.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-agora-core-secret': link.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
  } catch {
    throw new CoreUnavailable('El núcleo no responde.');
  }
  if (!response.ok) throw new CoreUnavailable(`El núcleo respondió ${response.status}.`);
  return await response.json() as T;
}
