const nav = typeof navigator !== 'undefined' ? `${navigator.platform} ${navigator.userAgent}` : '';

export const isMac = /Mac|iPhone|iPad/i.test(nav);
export const isWindows = /Win/i.test(nav);
export const hereLabel = isMac ? 'este Mac' : 'este equipo';
export const onlyHereLabel = isMac ? 'Solo en este Mac' : 'Solo en este equipo';
export const keystoreLabel = isMac ? 'el Llavero de macOS' : isWindows ? 'el Administrador de credenciales de Windows' : 'el almacén de credenciales del sistema';
export const listenShortcut = isMac ? '⌃⌥W' : 'Ctrl+Alt+W';
