/**
 * End-to-end verification of the STATIC build.
 *
 * Serves dist/ with the exact COOP/COEP headers Vercel will send, drives a real
 * headless Chromium, pushes a REAL video file into the file input, marks clips
 * at known timestamps, runs the in-browser export, then pulls the produced
 * blobs back out and ffprobes them on disk.
 *
 * This proves the BROWSER cut the video — not that the UI claimed it did.
 *
 *   node scripts/verify.mjs [distDir] [sourceVideo]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.argv[2] || join(root, 'dist');
const SOURCE = process.argv[3] || join(root, 'media', 'timecode-test.mp4');
const OUT = join(root, '.cache', 'verify');
const PORT = 8813;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const log = (s) => console.log(s);

/** Serve dist/ with production isolation headers, so the fast core is used. */
function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = join(DIST, p);
      if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end('nope'); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(body);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

/** Static check that production really will be cross-origin isolated. */
async function assertHeaders() {
  const cfg = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
  const all = (cfg.headers || []).flatMap((h) => h.headers.map((x) => x.key));
  const need = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'];
  const missing = need.filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`vercel.json is missing ${missing.join(', ')}`);
  log(`  vercel.json sets COOP + COEP → production is cross-origin isolated`);
}

async function main() {
  if (!existsSync(SOURCE)) { console.error(`source video not found: ${SOURCE}`); process.exit(2); }
  if (!existsSync(join(DIST, 'index.html'))) { console.error('dist/ not built — run: npm run build'); process.exit(2); }
  await mkdir(OUT, { recursive: true });

  await assertHeaders();
  const srv = await serve();
  log(`  serving ${DIST} on :${PORT} with COOP/COEP\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const shot = (n) => page.screenshot({ path: join(OUT, `${n}.png`) });

  log('--- loading app ---');
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  log(`  crossOriginIsolated: ${await page.evaluate(() => crossOriginIsolated)}`);
  log(`  SharedArrayBuffer  : ${await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined')}`);
  log(`  title              : ${await page.title()}`);
  await shot('01-landing');

  log('\n--- pushing a real video into the input (nothing is uploaded) ---');
  await page.setInputFiles('#file-input', SOURCE);
  await page.waitForFunction(() => document.querySelector('.screen:not([hidden])')?.dataset.screen === 'clip',
    null, { timeout: 60000 });
  log(`  screen   : ${await page.evaluate(() => document.querySelector('.screen:not([hidden])').dataset.screen)}`);
  log(`  probed   : ${await page.evaluate(() => JSON.stringify(window.__quiklip.state.info))}`);
  log(`  video dur: ${await page.evaluate(() => document.querySelector('#video').duration)}`);
  await shot('02-clip-screen');

  log('\n--- loading the wasm engine (~31 MB) ---');
  await page.waitForFunction(() => /ready/i.test(document.querySelector('#engine-label')?.textContent || ''),
    null, { timeout: 300000 });
  log(`  ${await page.evaluate(() => document.querySelector('#engine-label').textContent)}`);

  log('\n--- marking clips at known timestamps ---');
  const EXPECT = [
    { name: 'ten', start: 10.0, end: 15.0 },
    { name: 'forty', start: 47.5, end: 52.5 },
  ];
  await page.evaluate((clips) => {
    window.__quiklip.setClips(clips, { aspect: '9:16', focus: 'center', quality: 'standard', cap: 480 });
  }, EXPECT);
  log(`  clip rows: ${await page.evaluate(() => document.querySelectorAll('.clip-row').length)}`);
  await page.click('#btn-goto-export');
  await page.waitForTimeout(600);
  log(`  screen : ${await page.evaluate(() => document.querySelector('.screen:not([hidden])').dataset.screen)}`);
  log(`  summary: ${await page.evaluate(() => document.querySelector('#export-summary').innerText.replace(/\n/g, ' / '))}`);
  await shot('03-export-setup');

  log('\n--- running the in-browser export ---');
  const t0 = Date.now();
  await page.click('#btn-run-export');
  let last = '';
  const poll = setInterval(async () => {
    try {
      const t = await page.evaluate(() => document.querySelector('#ov-txt').textContent);
      if (t !== last) { log(`  ${t}`); last = t; }
    } catch {}
  }, 2000);
  await page.waitForFunction(() => !document.querySelector('#job-done').hidden, null, { timeout: 900000 });
  clearInterval(poll);
  log(`  wall-clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await shot('04-export-done');

  log('\n--- pulling the produced blobs out to disk ---');
  const count = await page.evaluate(() => window.__quiklip.exportsCount());
  if (!count) throw new Error('no clips were produced');
  log(`  clips produced: ${count}`);

  const results = [];
  for (let i = 0; i < count; i++) {
    const { name, bytes, b64 } = await page.evaluate(async (idx) => {
      const e = window.__quiklip.state.exports[idx];
      const buf = new Uint8Array(await e.blob.arrayBuffer());
      let s = '';
      const chunk = 0x8000;
      for (let j = 0; j < buf.length; j += chunk) s += String.fromCharCode.apply(null, buf.subarray(j, j + chunk));
      return { name: e.name, bytes: e.bytes, b64: btoa(s) };
    }, i);
    const dest = join(OUT, name);
    await writeFile(dest, Buffer.from(b64, 'base64'));
    results.push({ name, bytes, dest });
    log(`  wrote ${name} (${(bytes / 1024).toFixed(0)} KB)`);
  }

  log('\n--- ffprobe: did the browser really cut it right? ---');
  // exports[] is unshifted, so index 0 is the LAST clip encoded.
  const expected = [...EXPECT].reverse();
  let ok = true;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const want = expected[i];
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', r.dest]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    const dur = Number(j.format?.duration || 0);
    const wantDur = want ? want.end - want.start : null;
    const durOk = wantDur == null || Math.abs(dur - wantDur) < 0.35;
    // 9:16 of a 1280x720 source is 406x720. The 480 cap applies to the SHORT
    // side (406), which is already under it — so no scaling, and no upscaling.
    const dimOk = s.width === 406 && s.height === 720;
    log(`  ${r.name}: ${s.codec_name} ${s.width}x${s.height} ${dur.toFixed(3)}s` +
        ` (want ${wantDur?.toFixed(3)}s, 406x720) ${durOk && dimOk ? '✓' : '✗'}`);
    if (!durOk || !dimOk) ok = false;
  }

  log('\n--- console errors ---');
  log(errors.length ? errors.slice(0, 12).join('\n') : '  (none)');

  await browser.close();
  srv.close();

  if (!ok) { console.error('\nVERIFY FAILED — output did not match what was asked for\n'); process.exit(1); }
  log(`\nVERIFY OK — ${results.length} clips cut entirely in-browser. Files in ${OUT}\n`);
}

main().catch(async (e) => { console.error('\nVERIFY FAILED:', e.message, '\n'); process.exit(1); });
