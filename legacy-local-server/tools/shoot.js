#!/usr/bin/env node
/**
 * Zero-dependency phone-viewport screenshot harness for quiklip.
 *
 * Drives a headless Chrome over the DevTools Protocol using Node 22's built-in
 * WebSocket — no puppeteer, no npm install. Used as the project's verification
 * gate: never claim the UI works without a picture of it working.
 *
 *   node tools/shoot.js <baseUrl> <outDir>
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8790';
const OUT = process.argv[3] || path.join(__dirname, '..', '.cache', 'shots');
const PORT = 9333 + Math.floor(Math.random() * 200);

// iPhone 14 Pro logical viewport.
const DEVICE = { width: 393, height: 852, deviceScaleFactor: 2, mobile: true };

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const cache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cache)) {
    for (const v of fs.readdirSync(cache)) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]) {
        const p = path.join(cache, v, rel);
        if (fs.existsSync(p)) candidates.unshift(p);
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
    return r.result?.value;
  }
}

async function main() {
  const bin = findChrome();
  if (!bin) {
    console.error('No Chrome found. Install Chrome, or run: npx @puppeteer/browsers install chrome@stable');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quiklip-shot-'));

  const chrome = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint to come up.
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome DevTools endpoint never came up'); }

  // Create a page target and attach to it directly.
  const tr = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await tr.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      logs.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`EXCEPTION: ${m.params.exceptionDetails?.text} ${m.params.exceptionDetails?.exception?.description || ''}`);
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', DEVICE);
  // Touch emulation is optional — not present in every Chrome build.
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => {});

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    console.log(`shot: ${f}`);
    return f;
  };
  const tap = (sel) => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'MISSING '+${JSON.stringify(sel)};e.click();return 'ok'})()`);

  /* ─────────────────────── the actual walkthrough ─────────────────────── */
  const steps = [];
  const note = (s, v) => { steps.push(`${s}: ${v}`); console.log(`  ${s}: ${v}`); };

  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2200);
  await shot('01-library');
  note('library cards', await cdp.eval(`document.querySelectorAll('.vid-card').length`));

  // Open the first video.
  note('open video', await tap('.vid-card'));
  await sleep(3000);
  note('screen', await cdp.eval(`document.querySelector('.screen:not([hidden])').dataset.screen`));
  note('video readyState', await cdp.eval(`document.querySelector('#video').readyState`));
  note('video duration', await cdp.eval(`document.querySelector('#video').duration`));
  await shot('02-clip-loaded');

  // Simulate clipping: seek + mark in/out, three times, without pausing.
  await cdp.eval(`document.querySelector('#video').play().catch(()=>{})`);
  await sleep(600);

  const mark = async (at, len, name) => {
    await cdp.eval(`document.querySelector('#video').currentTime=${at}`);
    await sleep(450);
    await tap('#btn-mark');
    await sleep(250);
    await cdp.eval(`document.querySelector('#video').currentTime=${at + len}`);
    await sleep(450);
    await tap('#btn-mark');
    await sleep(300);
    note(name, await cdp.eval(`document.querySelectorAll('.clip-row').length + ' clips'`));
  };

  // Capture the armed (recording) state mid-way for the screenshot record.
  await cdp.eval(`document.querySelector('#video').currentTime=20`);
  await sleep(500);
  await tap('#btn-mark');
  await cdp.eval(`document.querySelector('#video').currentTime=26`);
  await sleep(600);
  await shot('03-armed-recording');
  note('armed badge visible', await cdp.eval(`!document.querySelector('#armed-badge').hidden`));
  note('button label', await cdp.eval(`document.querySelector('#mk-txt').textContent`));
  await tap('#btn-mark');
  await sleep(400);
  note('clip 1 banked', await cdp.eval(`document.querySelectorAll('.clip-row').length + ' clips'`));

  await mark(45, 8, 'clip 2');
  await mark(80, 12, 'clip 3');
  await sleep(400);
  await shot('04-clips-banked');

  note('clip rows', await cdp.eval(`
    Array.from(document.querySelectorAll('.clip-row')).map(r =>
      r.querySelector('.cr-name').textContent + ' ' + r.querySelector('.cr-time').textContent).join(' | ')`));
  note('timeline segments', await cdp.eval(`document.querySelectorAll('#tl-clips i').length`));

  // Clip editor sheet.
  await tap('.clip-row');
  await sleep(500);
  await shot('05-clip-editor');
  note('editor open', await cdp.eval(`!document.querySelector('#sheet-clip').hidden`));
  await tap('#ec-done');
  await sleep(400);

  // Settings sheet.
  await tap('#btn-settings');
  await sleep(500);
  await shot('06-settings');
  await tap('#sheet-close');
  await sleep(300);

  // Export screen.
  await tap('#btn-goto-export');
  await sleep(600);
  note('screen', await cdp.eval(`document.querySelector('.screen:not([hidden])').dataset.screen`));
  await tap('#opt-aspect button[data-v="9:16"]');
  await sleep(400);
  note('focus row shown for 9:16', await cdp.eval(`!document.querySelector('#focus-wrap').hidden`));
  await shot('07-export-setup');
  note('summary', await cdp.eval(`document.querySelector('#export-summary').innerText.replace(/\\n/g,' / ')`));

  // Run the export and watch progress.
  await tap('#btn-run-export');
  await sleep(2500);
  await shot('08-export-progress');
  note('progress text', await cdp.eval(`document.querySelector('#ov-txt').textContent`));

  for (let i = 0; i < 40; i++) {
    const done = await cdp.eval(`!document.querySelector('#job-done').hidden`);
    if (done) break;
    await sleep(1000);
  }
  await sleep(600);
  await shot('09-export-done');
  note('final', await cdp.eval(`document.querySelector('#ov-txt').textContent`));
  note('job rows', await cdp.eval(`
    Array.from(document.querySelectorAll('.job-row')).map(r =>
      r.querySelector('.jr-status').textContent).join(',')`));

  // Exports tab.
  await tap('#tabbar button[data-go="exports"]');
  await sleep(1500);
  await shot('10-exports');
  note('export groups', await cdp.eval(`document.querySelectorAll('.exp-group').length`));

  // Back to library.
  await tap('#tabbar button[data-go="library"]');
  await sleep(1200);
  await shot('11-library-return');
  note('saved-clip pill', await cdp.eval(`document.querySelector('.pill.ok')?.textContent || 'none'`));

  console.log('\n--- console errors ---');
  console.log(logs.length ? logs.slice(0, 20).join('\n') : '(none)');

  ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log('\nOK');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
