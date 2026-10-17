import type { ReactNode } from 'react';

export type SceneKind = 'city' | 'library' | 'integrations' | 'profile' | 'vault';
type Copy = { eyebrow: string; title: ReactNode; text: ReactNode; caption: string; hint: string };

// Texts shown around the 3D view for each place the user can be in.
export function sceneCopy(kind: SceneKind, firstPerson: boolean, name = ''): Copy {
  if (kind === 'integrations') return { eyebrow: '03 / CENTRO DE INTEGRACIONES', title: <>Tus servicios,<br/>a tu alcance.</>, text: 'Selecciona una terminal para explorar sus herramientas.', caption: 'INTEGRACIONES / CONSULTA DE HERRAMIENTAS', hint: 'WASD · selecciona una terminal · catálogos guardados' };
  if (kind === 'library') return { eyebrow: '02 / BIBLIOTECA', title: <>Un lugar para<br/>descubrir ideas.</>, text: 'Acércate a las estanterías o abre el catálogo.', caption: 'BIBLIOTECA / SOLO LECTURA', hint: 'Documentos de prueba · sin acceso a carpetas personales' };
  if (kind === 'vault') return { eyebrow: `05 / VAULT ${name.toUpperCase()}`, title: <>Tus notas,<br/>en sus estanterías.</>, text: 'Cada estantería es una carpeta de tu vault de Obsidian.', caption: 'OBSIDIAN / SOLO LECTURA', hint: 'WASD · abre una estantería · las notas solo salen del equipo si las consultas' };
  if (kind === 'profile') return { eyebrow: `04 / ESPACIO DE ${name.toUpperCase()}`, title: <>El espacio<br/>de {name}.</>, text: 'Su identidad, su memoria y sus servicios, en un solo lugar.', caption: 'PERFIL HERMES / SOLO LECTURA', hint: 'WASD · retrato, archivo, pantallas o escritorio · datos reales sin ejecutar el agente' };
  return { eyebrow: '01 / TU CIUDAD DIGITAL', title: <>Un espacio para<br/>cada posibilidad.</>, text: <>Recorre tus ideas. Encuentra a tus agentes.<br/>Construye tu propio entorno.</>, caption: 'AGORA / DISTRITO CENTRAL', hint: firstPerson ? 'Recorrido exterior' : 'Arrastra para girar · rueda para acercarte · selecciona un personaje' };
}
