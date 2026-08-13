/**
 * End-to-end verification of the CAMERA RECORDING path.
 *
 * Launches Chromium with a synthetic fake camera/mic (--use-fake-device-for-media-stream)
 * and pre-grants permissions, so getUserMedia/MediaRecorder run for real against a
 * fabricated but genuine media stream — no mocking of the app's own code.
 *
 * Drives: Library -> Record -> start -> record a few seconds -> stop -> review
 * -> "Use this recording" -> lands in Clip with a real playable video -> marks
 * a clip -> exports it -> ffprobes the result on disk.
 *
 *   node scripts/verify-record.mjs [distDir]
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
const OUT = join(root, '.cache', 'verify-record');
const PORT = 8818;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const log = (s) => console.log(s);

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

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) { console.error('dist/ not built — run: npm run build'); process.exit(2); }
  await mkdir(OUT, { recursive: true });

  const srv = await serve();
  log(`serving ${DIST} on :${PORT}\n`);

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',   // synthetic camera (moving pattern) + tone-generator mic
      '--use-fake-ui-for-media-stream',       // auto-accept the permission prompt
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const shot = (n) => page.screenshot({ path: join(OUT, `${n}.png`) });

  log('--- loading app ---');
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await shot('01-library');

  log('\n--- opening the record screen ---');
  await page.click('#btn-add-record');
  await page.waitForFunction(() => document.querySelector('.screen:not([hidden])')?.dataset.screen === 'record',
    null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#cam-preview')?.videoWidth > 0, null, { timeout: 15000 });
  const camDims = await page.evaluate(() => {
    const v = document.querySelector('#cam-preview');
    return `${v.videoWidth}x${v.videoHeight}`;
  });
  log(`  fake camera feeding preview: ${camDims}`);
  const camErrorShown = await page.evaluate(() => !document.querySelector('#cam-error').hidden);
  if (camErrorShown) {
    const msg = await page.evaluate(() => document.querySelector('#cam-error-msg').textContent);
    throw new Error(`camera failed to start: ${msg}`);
  }
  await shot('02-camera-ready');

  log('\n--- recording ---');
  await page.click('#btn-record-toggle');
  await page.waitForFunction(() => !document.querySelector('#cam-timer').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(3500); // record ~3.5s of synthetic video
  const timerText = await page.evaluate(() => document.querySelector('#cam-timer-txt').textContent);
  log(`  timer read: ${timerText}`);
  await shot('03-recording');

  await page.click('#btn-record-toggle'); // stop
  await page.waitForFunction(() => !document.querySelector('#cam-review').hidden, null, { timeout: 10000 });
  const reviewDur = await page.evaluate(() => document.querySelector('#cam-review-dur').textContent);
  log(`  review shows duration: ${reviewDur}`);
  await shot('04-review');

  log('\n--- using the recording ---');
  await page.click('#btn-use-recording');
  await page.waitForFunction(() => document.querySelector('.screen:not([hidden])')?.dataset.screen === 'clip',
    null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#video')?.duration > 0, null, { timeout: 15000 });
  const info = await page.evaluate(() => JSON.stringify(window.__quiklip.state.info));
  const recName = await page.evaluate(() => window.__quiklip.state.rec?.name);
  log(`  landed in Clip with: ${recName} | ${info}`);
  await shot('05-clip-from-recording');

  const camReleased = await page.evaluate(() => !document.querySelector('#cam-preview').srcObject);
  log(`  camera released after use: ${camReleased}`);

  log('\n--- marking a clip and exporting it ---');
  const dur = await page.evaluate(() => window.__quiklip.state.info.duration);
  const clipEnd = Math.max(0.6, dur - 0.3);
  await page.evaluate((end) => {
    window.__quiklip.setClips([{ name: 'from-recording', start: 0, end }],
      { aspect: 'original', focus: 'center', quality: 'standard', cap: 480 });
  }, clipEnd);
  await page.click('#btn-goto-export');
  await page.waitForTimeout(500);
  await page.click('#btn-run-export');
  await page.waitForFunction(() => !document.querySelector('#job-done').hidden, null, { timeout: 120000 });
  await shot('06-export-done');

  const count = await page.evaluate(() => window.__quiklip.exportsCount());
  if (!count) throw new Error('recording produced no exported clips');
  const { name, b64 } = await page.evaluate(async () => {
    const e = window.__quiklip.state.exports[0];
    const buf = new Uint8Array(await e.blob.arrayBuffer());
    let s = '';
    for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000));
    return { name: e.name, b64: btoa(s) };
  });
  const dest = join(OUT, name);
  await writeFile(dest, Buffer.from(b64, 'base64'));
  log(`  wrote ${name}`);

  log('\n--- ffprobe: is the exported clip a real, playable video? ---');
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', dest]);
  const probe = JSON.parse(stdout);
  const s = probe.streams?.[0] || {};
  const outDur = Number(probe.format?.duration || 0);
  log(`  ${name}: ${s.codec_name} ${s.width}x${s.height} ${outDur.toFixed(2)}s`);
  const ok = s.codec_name === 'h264' && s.width > 0 && s.height > 0 && outDur > 0.3;

  log('\n--- also proving Lightning (stream-copy) mode survives a webm recording ---');
  // This is the exact path the earlier movflags bug broke: copy-mode export
  // of a webm source used to crash ffmpeg with "Unrecognized option 'movflags'".
  await page.evaluate((end) => {
    window.__quiklip.setClips([{ name: 'copy-mode', start: 0, end }],
      { aspect: 'original', focus: 'center', quality: 'copy', cap: 0 });
  }, clipEnd);
  const copyResult = await page.evaluate(async () => {
    try {
      const r = await window.__quiklip.rawCut({
        start: 0, end: window.__quiklip.state.info.duration,
        settings: { aspect: 'original', focus: 'center', quality: 'copy', cap: 0 },
      });
      return { ok: true, bytes: r.bytes };
    } catch (e) { return { ok: false, err: String(e.message || e) }; }
  });
  log(`  copy-mode on recorded source: ${JSON.stringify(copyResult)}`);

  log('\n--- console errors ---');
  log(errors.length ? errors.slice(0, 12).join('\n') : '  (none)');

  await browser.close();
  srv.close();

  if (!ok) { console.error('\nVERIFY-RECORD FAILED — exported clip is not a valid video\n'); process.exit(1); }
  if (!copyResult.ok) { console.error('\nVERIFY-RECORD FAILED — Lightning mode broke on a recorded (webm) source\n'); process.exit(1); }
  log(`\nVERIFY-RECORD OK — recorded, reviewed, clipped, and exported entirely in-browser. Files in ${OUT}\n`);
}

main().catch((e) => { console.error('\nVERIFY-RECORD FAILED:', e.message, '\n'); process.exit(1); });
