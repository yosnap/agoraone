import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { importSchema, decodeDocument } from './private-library';

export const uploadSchema = importSchema.extend({
  base64: z.string().min(4).max(6990508),
}).strict();
let running = 0;

// Binary parsers run without inherited credentials, outside the HTTP process.
export async function extractUpload(input: z.infer<typeof uploadSchema>) {
  const binary = /\.(pdf|docx)$/i.test(input.name);
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > (binary ? 5 * 1024 * 1024 : 24576) || bytes.toString('base64') !== input.base64)
    throw new Error('Tamaño o codificación no válidos. TXT/Markdown: 24 KiB; PDF/DOCX: 5 MiB.');
  if (!binary) { decodeDocument(input.base64); return input; }
  if (running >= 2) throw new Error('Hay dos importaciones en curso. Inténtalo de nuevo en unos segundos.');
  running++;
  try {
    const content = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=128', fileURLToPath(new URL('./extract-document.mjs', import.meta.url)), input.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'], {
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 100000) child.kill('SIGKILL');
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('No se pudo iniciar la extracción.')); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0) throw new Error();
          const result = JSON.parse(output);
          if (typeof result.content !== 'string') throw new Error();
          resolve(result.content);
        } catch { reject(new Error('No se pudo extraer el texto. Comprueba que el archivo no esté protegido o dañado, contenga texto seleccionable y no supere 100 páginas PDF ni 24 KiB de texto. No se aplica OCR.')); }
      });
      child.stdin.end(bytes);
    });
    const base64 = Buffer.from(content).toString('base64');
    decodeDocument(base64);
    return { name: input.name, base64 };
  } finally { running--; }
}
