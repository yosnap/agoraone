import type { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';

/** Where the Python core listens and the secret of the current start (server/core-process.ts). */
export type CoreLink = { url: string; secret: string };

const maxBody = 1024 * 1024;
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const forwardedRequestHeaders = ['content-type', 'accept', 'last-event-id'];
const forwardedResponseHeaders = ['content-type', 'content-disposition'];

const unavailable = (res: Response) =>
  res.status(503).json({ error: 'El núcleo de AgoraOne no está disponible. Reinícialo con «npm run dev».' });

async function readBody(req: Request) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Forwards /api/core/* to the core. Mounted after AgoraOne's own checks (Host, Origin, access cookie,
 * CSRF), so the core only sees requests that already passed them. The browser's cookies never reach
 * the core: it gets the start secret and the authenticated owner instead. Responses are streamed so
 * Server-Sent Events work through it.
 */
export function coreProxy(link: CoreLink | undefined, timeoutMs = 120_000) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!link) return unavailable(res);
    if (!methods.has(req.method)) return res.status(405).json({ error: 'Método no admitido.' });
    // A path starting with // would be read as another host; it has no use here, so it is refused outright.
    if (req.url.startsWith('//')) return res.status(400).json({ error: 'Ruta no válida.' });
    // Only the path and query of the request.
    const requested = new URL(req.url, 'http://core.invalid');
    const target = new URL(link.url);
    // /internal/* is for the backend's own calls (e.g. writing the index): never from the browser.
    let decoded = requested.pathname;
    try { decoded = decodeURIComponent(requested.pathname); } catch { return res.status(400).json({ error: 'Ruta no válida.' }); }
    if (/^\/+internal(\/|$)/i.test(decoded)) return res.status(404).json({ error: 'No disponible.' });
    target.pathname = requested.pathname;
    target.search = requested.search;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody ? await readBody(req) : undefined;
    if (body === null) return res.status(413).json({ error: 'La petición es demasiado grande.' });
    const headers: Record<string, string> = { 'x-agora-core-secret': link.secret, 'x-agora-owner': res.locals.owner };
    for (const name of forwardedRequestHeaders) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const abort = new AbortController();
    // The time limit covers waiting for the core's answer to start; a stream may then last as long as the
    // browser keeps it open (closing it aborts the request to the core).
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    res.on('close', () => abort.abort());
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, { method: req.method, headers, body, signal: abort.signal, redirect: 'manual' });
    } catch {
      return res.headersSent ? res.end() : unavailable(res);
    } finally {
      clearTimeout(timer);
    }
    // A 401 from the core means it does not hold this start's secret (e.g. a core left from another start),
    // not that the browser lost its access cookie.
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      return res.status(503).json({ error: 'El núcleo en marcha pertenece a otro arranque de AgoraOne. Reinicia AgoraOne.' });
    }
    res.status(upstream.status);
    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
      .on('error', error => { if (!res.headersSent) next(error); else res.end(); })
      .pipe(res);
  };
}
