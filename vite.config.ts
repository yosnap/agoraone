import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The 3D stack (three.js, React Three Fiber, effects) is one cacheable chunk loaded after the interface.
  build: { chunkSizeWarningLimit: 1600, rollupOptions: { output: { manualChunks: id => !id.includes('node_modules') ? undefined
    : /three|postprocessing|n8ao|meshoptimizer|maath|troika|camera-controls/.test(id) ? 'three' : /[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : /@codemirror|@lezer|crelt|style-mod|w3c-keyname/.test(id) ? 'editor' : 'vendor' } } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.agora/**', '**/server/**', '**/resources/**'] },
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
