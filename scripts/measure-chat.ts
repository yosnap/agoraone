import { randomUUID } from 'node:crypto';
import { runBridge } from '../server/hermes-adapter';
import { closeHermesWorkers } from '../server/hermes-worker';

// Two billable synthetic prompts; no profile files or personal documents.
if (!process.argv.includes('--live')) throw new Error('Añade --live para ejecutar dos consultas reales de prueba.');
const sessionId = `agora-${randomUUID()}`;
try {
  for (let turn = 1; turn <= 2; turn++) {
    const start = performance.now();
    let first = false;
    const result = await runBridge({ action: 'chat', sessionId, message: 'Responde solo: listo', history: [] }, event => {
      if (event.type === 'status' && event.stage === 'generating') console.log({ turn, startupMs: event.startupMs });
      if (event.type === 'delta' && !first) {
        first = true; console.log({ turn, firstTextMs: Math.round(performance.now() - start) });
      }
    });
    console.log({ turn, totalMs: Math.round(performance.now() - start), replyReceived: typeof result.reply === 'string' });
  }
} finally { closeHermesWorkers(); }
