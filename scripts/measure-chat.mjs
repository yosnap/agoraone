import { readFileSync } from 'node:fs';

// Two billable synthetic prompts to Luma through the running AgoraOne (npm run dev): start-up, first text and
// total time of each turn. No profile files or personal documents; prints only times.
if (!process.argv.includes('--live')) throw new Error('Añade --live para ejecutar dos consultas reales de prueba.');
const base = 'http://127.0.0.1:4317';
const headers = { Host: '127.0.0.1:4317', Origin: base, 'Content-Type': 'application/json' };
const token = readFileSync('.agora/access-token', 'utf8').trim();
const session = await fetch(`${base}/api/session`, { method: 'POST', headers, body: JSON.stringify({ token }) });
const access = session.headers.get('set-cookie').split(';')[0];
const status = await fetch(`${base}/api/status`, { headers: { ...headers, Cookie: access } });
const cookie = `${access}; ${status.headers.get('set-cookie').split(';')[0]}`;
const { csrf } = await status.json();
const send = (path, body, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-Agora-CSRF': csrf, ...extra }, body: JSON.stringify(body) });
const { id } = await (await send('/api/conversations', { agent: 'luma', context: 'library-lobby' })).json();
for (let turn = 1; turn <= 2; turn++) {
  const start = performance.now();
  const response = await send(`/api/conversations/${id}/messages`, { message: 'Responde solo: listo' }, { Accept: 'application/x-ndjson' });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', first = false, done = false;
  while (!done) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let line;
    while ((line = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, line)); buffer = buffer.slice(line + 1);
      if (event.type === 'status' && event.stage === 'generating') console.log({ turn, startupMs: event.startupMs });
      if (event.type === 'delta' && !first) { first = true; console.log({ turn, firstTextMs: Math.round(performance.now() - start) }); }
      if (event.type === 'done' || event.type === 'error') { done = true; console.log({ turn, totalMs: Math.round(performance.now() - start), replyReceived: event.type === 'done' }); }
    }
  }
}
