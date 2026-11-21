const nav = typeof navigator !== 'undefined' ? `${navigator.platform} ${navigator.userAgent}` : '';

export const isMac = /Mac|iPhone|iPad/i.test(nav);
export const isWindows = /Win/i.test(nav);
export const hereLabel = isMac ? 'este Mac' : 'este equipo';
export const onlyHereLabel = isMac ? 'Solo en este Mac' : 'Solo en este equipo';
export const keystoreLabel = isMac ? 'el Llavero de macOS' : isWindows ? 'el Administrador de credenciales de Windows' : 'el almacén de credenciales del sistema';
// For phrases like «en el Llavero», «del Llavero», «al Llavero»: on macOS they read exactly as before.
export const keystoreName = isMac ? 'Llavero' : isWindows ? 'Administrador de credenciales de Windows' : 'almacén de credenciales del sistema';
export const machineName = isMac ? 'Mac' : 'ordenador';
// The top bar's «LOCAL · MAC» names the system AgoraOne runs on.
export const systemTag = isMac ? 'MAC' : isWindows ? 'WINDOWS' : 'LINUX';
export const listenShortcut = isMac ? '⌃⌥W' : 'Ctrl+Alt+W';
// Where a saved file is shown: the Finder, the Explorer, or the system's file manager.
export const revealLabel = isMac ? 'Mostrar en Finder' : isWindows ? 'Mostrar en el Explorador' : 'Mostrar en la carpeta';
// Who asks before letting the phone in: macOS, or the system or its firewall elsewhere.
export const incomingAsker = isMac ? 'macOS' : 'el sistema o su cortafuegos';
// Watson's voice when VoiceStudio does not speak is the system's own («la voz de macOS» on a Mac).
export const systemVoiceOf = isMac ? 'de macOS' : 'del sistema';
// Meetings record the system's sound too on macOS and Linux; on Windows, only the microphone.
export const recordsSystemAudio = !isWindows;
export const meetingSourcesLabel = isMac
  ? 'Tu micrófono y lo que suena en el Mac (Meet, Zoom, Teams), en este equipo.'
  : isWindows
    ? 'Tu micrófono, en este equipo (en Windows no se graba lo que suena en el ordenador).'
    : 'Tu micrófono y lo que suena en el equipo (Meet, Zoom, Teams), en este equipo.';
