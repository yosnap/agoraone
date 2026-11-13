import type { NextFunction, Request, Response } from 'express';
import { Readable } from 'node:stream';

/** Where the Python core listens and the secret of the current start (server/core-process.ts). */
export type CoreLink = { url: string; secret: string };

const maxBody = 1024 * 1024;
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
    // Only the path and query of the request: a path such as //host cannot change where it goes.
    const requested = new URL(req.url, 'http://core.invalid');
    const target = new URL(link.url);
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
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    res.on('close', () => abort.abort());
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, { method: req.method, headers, body, signal: abort.signal, redirect: 'manual' });
    } catch {
      clearTimeout(timer);
      return res.headersSent ? res.end() : unavailable(res);
    }
    res.status(upstream.status);
    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) { clearTimeout(timer); return res.end(); }
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
      .on('error', error => { clearTimeout(timer); if (!res.headersSent) next(error); else res.end(); })
      .on('end', () => clearTimeout(timer))
      .pipe(res);
  };
}
