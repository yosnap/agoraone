// Standalone parser: receives bytes on stdin; never receives a user path or credentials.
import yauzl from 'yauzl';
// Parser diagnostics must not contaminate the structured stdout protocol.
console.log = console.warn = () => {};

async function validateZip(bytes) {
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let total = 0, actual = 0, count = 0;
      const names = new Set();
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        total += entry.uncompressedSize;
        if (++count > 1000 || total > 16 * 1024 * 1024 || entry.isEncrypted() || names.has(entry.fileName))
          return fail(new Error('ZIP limits'));
        names.add(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          stream.on('error', fail);
          stream.on('data', chunk => {
            actual += chunk.length;
            if (actual > 16 * 1024 * 1024) { stream.destroy(); fail(new Error('ZIP expansion')); }
          });
          stream.on('end', () => zip.readEntry());
        });
      });
      zip.on('end', () => names.has('word/document.xml') && names.has('[Content_Types].xml') ? resolve() : reject(new Error('Not DOCX')));
      zip.readEntry();
    });
  });
}

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 5 * 1024 * 1024) throw new Error('Input limit');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  let content = '';
  if (process.argv[2] === 'pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Not PDF');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 100) throw new Error('Page limit');
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const text = await page.getTextContent();
        content += text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
        if (Buffer.byteLength(content) > 24576) throw new Error('Text limit');
        page.cleanup();
      }
    } finally { await loading.destroy(); }
  } else {
    await validateZip(bytes);
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    if (result.messages.some(message => message.type === 'error')) throw new Error('DOCX error');
    content = result.value;
  }
  content = content.trim();
  if (!content || Buffer.byteLength(content) > 24576 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error('Invalid text');
  process.stdout.write(JSON.stringify({ content }));
} catch { process.exitCode = 1; }
