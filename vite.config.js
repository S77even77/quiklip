import { defineConfig } from 'vite';

// ffmpeg.wasm's multithreaded core needs SharedArrayBuffer, which browsers only
// expose to cross-origin-isolated pages. These headers provide that in dev and
// preview; vercel.json provides the same in production. Without them the app
// still works — it falls back to the single-threaded core (slower).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: '/',
  server: { headers: isolation, host: true },
  preview: { headers: isolation, host: true },
  // Pre-bundling rewrites the internal `new Worker(new URL(...))` and breaks
  // ffmpeg's worker bootstrap — keep these as-is.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  // Must stay a CLASSIC worker: ffmpeg's worker calls importScripts() to pull in
  // the UMD core, and importScripts does not exist inside ES module workers.
  worker: { format: 'iife' },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1200,
    // The 31 MB cores live in public/ and are copied verbatim, not bundled.
  },
});
