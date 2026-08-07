/**
 * Copy the ffmpeg.wasm cores out of node_modules into public/ before a build.
 *
 * Why not commit them: they are ~62 MB of binary. Copying at build time keeps
 * the git repo tiny while still SELF-HOSTING the cores in the deployed site —
 * no CDN, no third-party request at runtime, and the COEP header stays happy.
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ESM, not UMD. @ffmpeg/ffmpeg always spawns its worker with { type: "module" },
// so importScripts() is unavailable and it falls back to `await import(coreURL)`.
// The UMD build is not an ES module, so that import throws ERROR_IMPORT_FAILURE
// ("failed to import ffmpeg-core.js") and load() never resolves.
const JOBS = [
  { pkg: '@ffmpeg/core', dest: 'st', files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
  { pkg: '@ffmpeg/core-mt', dest: 'mt', files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'] },
];

let copied = 0;
for (const job of JOBS) {
  const from = join(root, 'node_modules', job.pkg, 'dist', 'esm');
  const to = join(root, 'public', 'ffmpeg', job.dest);
  if (!existsSync(from)) {
    console.error(`\n  ✗ ${job.pkg} is not installed. Run: npm install\n`);
    process.exit(1);
  }
  mkdirSync(to, { recursive: true });
  for (const f of job.files) {
    const src = join(from, f);
    if (!existsSync(src)) {
      console.error(`  ✗ missing ${job.pkg}/dist/umd/${f}`);
      process.exit(1);
    }
    copyFileSync(src, join(to, f));
    copied++;
  }
  const mb = (statSync(join(to, 'ffmpeg-core.wasm')).size / 1048576).toFixed(1);
  console.log(`  ✓ ${job.pkg} → public/ffmpeg/${job.dest} (${mb} MB core)`);
}
console.log(`  ${copied} files staged\n`);
