import { createApp } from './app';
import { loadAccessToken } from './access-token';

const token = loadAccessToken();
createApp({ accessToken: token }).listen(4317, '127.0.0.1', () => {
  console.log('AgoraOne backend: http://127.0.0.1:4317');
  // Printed only to the user's own terminal: the link that lets this browser in (once; then a cookie remembers it).
  console.log(`Abre AgoraOne con este enlace: http://127.0.0.1:5173/#acceso=${token}`);
});
