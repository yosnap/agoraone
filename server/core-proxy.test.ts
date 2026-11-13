import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { BackgroundReads } from './background-reads';

const token = 'f'.repeat(64);
const secret = 'e'.repeat(64);
type Seen = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string };

const listen = async (server: Server) => {
  if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sin puerto');
  return `http://127.0.0.1:${address.port}`;
};

// Plain node:http, so the Host header can be set like the browser sends it.
const send = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<{ status: number; headers: IncomingMessage['headers']; text: string }>((resolve, reject) => {
    const req = httpRequest(url, { method: options.method || 'GET', headers: options.headers }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(options.body);
  });

/** A stand-in for the Python core that records what reaches it. */
async function fakeCore() {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'core=1' });
        res.write('data: uno\n\n'); setTimeout(() => res.end('data: dos\n\n'), 20);
        return;
      }
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  return { seen, url: await listen(server), close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function agora(coreUrl?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agora-core-proxy-')));
  const reads = new BackgroundReads(null);
  const server = createApp({ directory, reads, accessToken: token, core: coreUrl ? { url: coreUrl, secret } : undefined });
  const http = server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  const url = await listen(http);
  const base = { Host: '127.0.0.1:4317', Origin: 'http://127.0.0.1:4317' };
  const session = await send(`${url}/api/session`, { method: 'POST', headers: { ...base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const access = String(session.headers['set-cookie']).split(';')[0];
  const status = await send(`${url}/api/status`, { headers: { ...base, Cookie: access } });
  const cookie = `${access}; ${String(status.headers['set-cookie']).split(';')[0]}`;
  const { csrf } = JSON.parse(status.text);
  const call = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    send(`${url}${path}`, { ...options, headers: { ...base, Cookie: cookie, 'X-Agora-CSRF': csrf, ...options.headers } });
  return { call, close: async () => { await reads.close(); rmSync(directory, { recursive: true }); return new Promise<void>(resolve => { http.closeAllConnections(); http.close(() => resolve()); }); } };
}

test('el núcleo solo recibe peticiones con cookie de acceso y CSRF, también en GET', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  try {
    assert.equal((await app.call('/api/core/health', { headers: { Cookie: '' } })).status, 401);
    assert.equal((await app.call('/api/core/health', { headers: { 'X-Agora-CSRF': 'otro' } })).status, 403);
    assert.equal((await app.call('/api/core/health', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal(core.seen.length, 0, 'nada llega al núcleo sin pasar las comprobaciones');
    assert.equal((await app.call('/api/core/health')).status, 200);
  } finally { await app.close(); await core.close(); }
});

test('el proxy añade secreto y propietario, conserva método, cuerpo y estado, y no filtra cookies', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  try {
    const posted = await app.call('/api/core/items?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.equal(posted.status, 200);
    const [seen] = core.seen;
    assert.equal(seen.method, 'POST'); assert.equal(seen.url, '/items?x=1'); assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.headers['x-agora-core-secret'], secret);
    assert.match(String(seen.headers['x-agora-owner']), /^[a-f0-9]{64}$/);
    assert.equal(seen.headers.cookie, undefined, 'las cookies del navegador no llegan al núcleo');
    assert.equal(seen.headers['x-agora-csrf'], undefined);
    assert.equal((await app.call('/api/core/missing')).status, 404);
  } finally { await app.close(); await core.close(); }
});

test('una ruta con doble barra no cambia el destino del proxy', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  try {
    const response = await app.call('/api/core//evil.example/x');
    assert.equal(response.status, 200);
    assert.equal(core.seen.at(-1)?.headers.host, new URL(core.url).host);
  } finally { await app.close(); await core.close(); }
});

test('eventos del núcleo llegan en streaming sin reenviar sus cookies', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  try {
    const events = await app.call('/api/core/events', { headers: { Accept: 'text/event-stream' } });
    assert.match(String(events.headers['content-type']), /text\/event-stream/);
    assert.equal(events.text, 'data: uno\n\ndata: dos\n\n');
    assert.equal(events.headers['set-cookie'], undefined);
  } finally { await app.close(); await core.close(); }
});

test('cuerpo demasiado grande y núcleo ausente devuelven errores claros', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  const down = await agora('http://127.0.0.1:9');
  const none = await agora();
  try {
    const big = await app.call('/api/core/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(big.status, 413);
    assert.equal((await down.call('/api/core/health')).status, 503);
    assert.equal((await none.call('/api/core/health')).status, 503);
    assert.match(JSON.parse((await none.call('/api/core/health')).text).error, /núcleo/);
  } finally { await app.close(); await down.close(); await none.close(); await core.close(); }
});

test('las rutas de la API con otras mayúsculas no esquivan la cookie de acceso ni el CSRF', async () => {
  const core = await fakeCore();
  const app = await agora(core.url);
  try {
    for (const path of ['/API/status', '/Api/core/whoami', '/API/CORE/health', '/api/Core/health']) {
      const response = await app.call(path, { headers: { Cookie: '' } });
      assert.ok([401, 404].includes(response.status), `${path} respondió ${response.status}`);
      assert.doesNotMatch(response.text, /csrf/i, `${path} no debe revelar el CSRF`);
    }
    const posted = await app.call('/API/conversations', { method: 'POST', headers: { Cookie: '', Origin: '', 'X-Agora-CSRF': '', 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok([401, 403, 404].includes(posted.status), `POST respondió ${posted.status}`);
    assert.equal(core.seen.length, 0, 'nada llega al núcleo');
  } finally { await app.close(); await core.close(); }
});
