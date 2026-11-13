import { createApp } from './app';
import { loadAccessToken } from './access-token';
import { startCore } from './core-process';
import { BackgroundReads } from './background-reads';
import { BrainSync } from './brain-sync';

const token = loadAccessToken();
const core = startCore();
const reads = new BackgroundReads();
createApp({ accessToken: token, core: core.link, reads }).listen(4317, '127.0.0.1', () => {
  console.log('AgoraOne backend: http://127.0.0.1:4317');
  // Printed only to the user's own terminal: the link that lets this browser in (once; then a cookie remembers it).
  console.log(`Abre AgoraOne con este enlace: http://127.0.0.1:5173/#acceso=${token}`);
});
// Keeps the brain's index in step with the Obsidian vaults (server/brain-sync.ts).
new BrainSync(reads, core.link).start();
