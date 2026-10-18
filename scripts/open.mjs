import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Opens AgoraOne in the default browser with the private access link (the token stays on this machine).
const token = readFileSync('.agora/access-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Arranca AgoraOne una vez (npm run dev) para crear el enlace de acceso.');
execFileSync('/usr/bin/open', [`http://127.0.0.1:5173/#acceso=${token}`]);
console.log('AgoraOne abierto en el navegador con el enlace de acceso.');
