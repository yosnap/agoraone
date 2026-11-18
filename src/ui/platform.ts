const nav = typeof navigator !== 'undefined' ? `${navigator.platform} ${navigator.userAgent}` : '';

export const isMac = /Mac|iPhone|iPad/i.test(nav);
export const isWindows = /Win/i.test(nav);
export const hereLabel = isMac ? 'este Mac' : 'este equipo';
export const onlyHereLabel = isMac ? 'Solo en este Mac' : 'Solo en este equipo';
export const keystoreLabel = isMac ? 'el Llavero de macOS' : isWindows ? 'el Administrador de credenciales de Windows' : 'el almacén de credenciales del sistema';
// For phrases like «en el Llavero», «del Llavero», «al Llavero»: on macOS they read exactly as before.
export const keystoreName = isMac ? 'Llavero' : isWindows ? 'Administrador de credenciales de Windows' : 'almacén de credenciales del sistema';
export const machineName = isMac ? 'Mac' : 'ordenador';
export const listenShortcut =isMac ? '⌃⌥W' : 'Ctrl+Alt+W';
// Meetings record the system's sound too on macOS and Linux; on Windows, only the microphone.
export const recordsSystemAudio = !isWindows;
export const meetingSourcesLabel = isMac
  ? 'Tu micrófono y lo que suena en el Mac (Meet, Zoom, Teams), en este equipo.'
  : isWindows
    ? 'Tu micrófono, en este equipo (en Windows no se graba lo que suena en el ordenador).'
    : 'Tu micrófono y lo que suena en el equipo (Meet, Zoom, Teams), en este equipo.';
