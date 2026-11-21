declare const __APP_VERSION__: string | undefined;

/** The running version, from package.json at build time ('dev' if the build did not define it, e.g. some tests). */
export const appVersion: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
