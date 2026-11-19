import type { ModuleName } from '../api/core';

/** What turning off each module of a connector does (said on its card, and in Ajustes › Módulos when an older core
 * does not say which connector holds it). */
export const moduleMeaning: Partial<Record<ModuleName, string>> = {
  central: 'deja de leer Central y no usa sus clientes; la conexión se conserva',
  presupuestos: 'Watson no propone presupuestos ni se crean en Central',
  fabrica: 'oculta Mi fábrica y cierra su ventana; la fábrica sigue funcionando por su cuenta',
  crmdev: 'deja de leer CRMDev y oculta su sección; la conexión se conserva',
};

/** A readable name for a module before its label arrives (or if it never does): the core's label, else the given
 * fallback (such as the connector's own name), else the id with a capital letter. */
export function moduleLabel(name: string, labels: Partial<Record<string, string>>, fallback?: string): string {
  return labels[name] ?? fallback ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}
