import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The version shown under the logo and in Novedades comes from package.json, the one the version bump updates.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Scan every source file at start-up, lazy ones included (the brain's 3D graph, the editor), so their
  // dependencies are pre-bundled before the first page asks for them. Otherwise Vite finds three.js late,
  // re-bundles it and the page that was already loading it gets «504 Outdated Optimize Dep» and goes blank.
  optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}'] },
  // The 3D stack (three.js, React Three Fiber, effects) is one cacheable chunk loaded after the interface.
  build: { chunkSizeWarningLimit: 1600, rollupOptions: { output: { manualChunks: id => !id.includes('node_modules') ? undefined
    : /three|postprocessing|n8ao|meshoptimizer|maath|troika|camera-controls/.test(id) ? 'three' : /[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : /@codemirror|@lezer|crelt|style-mod|w3c-keyname/.test(id) ? 'editor' : 'vendor' } } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.agora/**', '**/resources/**'] },
    proxy: { '/api': 'http://127.0.0.1:4317' },
    // Rust's build output and the core's virtual environment are not the interface; on Windows the running
    // .exe/.pdb there are locked and watching them only floods the log with EBUSY.
    watch: { ignored: ['**/desktop/target/**', '**/core/.venv/**', '**/.agora/**'] },
  },
});
