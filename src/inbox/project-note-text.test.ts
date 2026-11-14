import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFolder, noteContent, noteTitle, projectsBase, withLevel } from './project-note-text';

const folders = ['- Clientes/Proyectos/Artilabs', '- Clientes/Proyectos/Artilabs/Clientes Artilabs', '- Clientes/Proyectos/Coetools',
  '- Clientes/Proyectos/FoodZinder', '- Clientes/Proyectos/Foodzinder-web', 'Fundación PC/Clientes', 'Empresa/Proyectos'];

test('la carpeta de proyectos es la que cuelga de clientes', () => {
  assert.equal(projectsBase(folders), '- Clientes/Proyectos');
  assert.equal(projectsBase(['Empresa/Proyectos/X']), 'Empresa/Proyectos');
  assert.equal(projectsBase(['Casa', 'Notas']), null);
});

test('el cliente va a su carpeta si existe y, si no, a una nueva con su nombre', () => {
  const base = '- Clientes/Proyectos';
  assert.deepEqual(clientFolder(folders, base, 'Artilabs S.L.'), { folder: `${base}/Artilabs`, exists: true });
  assert.deepEqual(clientFolder(folders, base, 'Foodzinder'), { folder: `${base}/FoodZinder`, exists: true }, 'sin confundirla con Foodzinder-web');
  assert.deepEqual(clientFolder(folders, base, 'Co Labs'), { folder: `${base}/Co Labs`, exists: false }, 'un nombre corto no cae en Coetools');
  assert.deepEqual(clientFolder(folders, base, 'Bloom: Marbella'), { folder: `${base}/Bloom Marbella`, exists: false });
  assert.deepEqual(clientFolder(folders, base, 'Foodzinder Web S.L.'), { folder: `${base}/Foodzinder-web`, exists: true }, 'la suya, no la de FoodZinder');
  assert.deepEqual(clientFolder(folders, base, 'Foodzinder Labs'), { folder: `${base}/Foodzinder Labs`, exists: false }, 'un nombre parecido es otro cliente');
  assert.deepEqual(clientFolder(folders, base, 'Arti Studio'), { folder: `${base}/Arti Studio`, exists: false });
  assert.deepEqual(clientFolder(folders, base, 'COETOOLS, S.L.U.'), { folder: `${base}/Coetools`, exists: true });
});

test('una nota por correo, con el formato de las notas del usuario', () => {
  assert.equal(noteTitle('- Clientes/Proyectos/Artilabs', 'RE: Fwd: Cambios en el calendario', '2026-11-15T09:30:00Z'), 'Artilabs - Cambios en el calendario 15-11-2026');
  assert.equal(noteTitle('X/Y', '.a/b: c?\u200d', '2026-01-02T12:00:00Z'), 'Y - a b c 02-01-2026', 'sin caracteres que Obsidian no acepta');
  const content = noteContent({ subject: 'Re: calendario', sentAt: '2026-11-15T09:30:00Z', from: { name: 'Ana', address: 'ana@ejemplo.es' },
    summary: 'Quiere mover la sesión.', asks: ['Mover el jueves al lunes 23'] }, 'Plataforma');
  assert.equal(content, '# calendario\n\n- Fecha: 15/11/2026\n- De: Ana (ana@ejemplo.es)\n- Proyecto: Plataforma\n- Correo: «Re: calendario»\n\n## Qué piden\n- Mover el jueves al lunes 23\n\n## Resumen\nQuiere mover la sesión.\n');
});

test('la nota de un correo privado o solo en este Mac lo dice en sus propiedades', () => {
  assert.equal(withLevel('# x\n', 'normal'), '# x\n');
  assert.equal(withLevel('# x\n', 'local_only'), '---\nconfidencialidad: solo-local\n---\n# x\n');
  assert.equal(withLevel('# x\n', 'private'), '---\nconfidencialidad: privado\n---\n# x\n');
});
