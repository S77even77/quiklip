#!/usr/bin/env node
/**
 * Layout inspector — screenshots the Clip screen at several viewport sizes and
 * reports any interactive element that overflows its container or the viewport.
 *
 *   node tools/inspect.js <baseUrl> <outDir>
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8790';
const OUT = process.argv[3] || path.join(__dirname, '..', '.cache', 'inspect');
const PORT = 9600 + Math.floor(Math.random() * 200);

const VIEWPORTS = [
  { name: 'laptop-1440x900', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  { name: 'laptop-short-1280x720', width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
  { name: 'iphone-393x852', width: 393, height: 852, deviceScaleFactor: 2, mobile: true },
  { name: 'iphone-se-375x667', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
];

function findChrome() {
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const cache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cache)) {
    for (const v of fs.readdirSync(cache)) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]) {
        const p = path.join(cache, v, rel);
        if (fs.existsSync(p)) cands.unshift(p);
      }
    }
  }
  return cands.find((c) => fs.existsSync(c));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' timeout')); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
}

// Runs in the page: find controls clipped by the viewport or by an ancestor.
const OVERFLOW_PROBE = `(() => {
  const vh = innerHeight, vw = innerWidth;
  const out = [];
  const screen = document.querySelector('.screen:not([hidden])');
  if (!screen) return out;
  for (const el of screen.querySelectorAll('button, a, input, .clip-row, .mark-btn')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const label = (el.id ? '#'+el.id : '') + (el.className && typeof el.className === 'string' ? '.'+el.className.trim().split(/\\s+/).join('.') : '');
    const text = (el.innerText||'').trim().replace(/\\n/g,' ').slice(0,26);
    const problems = [];
    if (r.bottom > vh + 0.5) problems.push('below viewport by ' + Math.round(r.bottom - vh) + 'px');
    if (r.top < -0.5) problems.push('above viewport by ' + Math.round(-r.top) + 'px');
    if (r.right > vw + 0.5) problems.push('right of viewport by ' + Math.round(r.right - vw) + 'px');
    if (r.left < -0.5) problems.push('left of viewport by ' + Math.round(-r.left) + 'px');
    // Clipped by a NON-scrollable ancestor. An element sitting below the fold of a
    // scrollable list is reachable, so it is not a defect — walk past those.
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1;
      if (scrollable) break;
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        const pr = p.getBoundingClientRect();
        if (r.bottom > pr.bottom + 1) problems.push('CLIPPED by ' + (p.id?'#'+p.id:p.className) + ' by ' + Math.round(r.bottom - pr.bottom) + 'px (unreachable)');
        break;
      }
      p = p.parentElement;
    }
    if (problems.length) out.push({ el: label, text, rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], problems });
  }
  return out;
})()`;

async function main() {
  const bin = findChrome();
  if (!bin) { console.error('no chrome'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quiklip-insp-'));
  const chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (wsUrl) break; } catch {}
    await sleep(250);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('no devtools endpoint'); }

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const tap = (sel) => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'MISSING';e.click();return 'ok'})()`);

  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', vp);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2000);
    await tap('.vid-card');
    await sleep(2500);

    // bank two clips + leave one open, so both states are on screen
    const mk = async (a, b) => {
      await cdp.eval(`document.querySelector('#video').currentTime=${a}`); await sleep(350);
      await tap('#btn-mark'); await sleep(200);
      await cdp.eval(`document.querySelector('#video').currentTime=${b}`); await sleep(350);
      await tap('#btn-mark'); await sleep(250);
    };
    await mk(10, 18);
    await mk(30, 44);
    await cdp.eval(`document.querySelector('#video').currentTime=60`); await sleep(300);
    await tap('#btn-mark'); // leave OPEN
    await cdp.eval(`document.querySelector('#video').currentTime=68`); await sleep(400);

    const shot = async (n) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(data, 'base64'));
    };
    await shot(vp.name);

    const problems = await cdp.eval(OVERFLOW_PROBE);
    console.log(`\n### ${vp.name} (${vp.width}x${vp.height})`);
    if (!problems.length) console.log('  no clipped controls');
    for (const p of problems) console.log(`  ${p.el}\n     text="${p.text}" rect=${p.rect.join(',')}\n     -> ${p.problems.join('; ')}`);

    const geo = await cdp.eval(`(() => {
      const g = s => { const e = document.querySelector(s); if(!e) return s+': MISSING';
        const r = e.getBoundingClientRect(); return s+': y='+Math.round(r.y)+' h='+Math.round(r.height)+' bottom='+Math.round(r.bottom); };
      return [g('.player-wrap'),g('.timeline'),g('.transport'),g('.speed-row'),g('.mark-zone'),g('.clips-panel'),g('.clip-list'),g('#tabbar')].join('\\n     ');
    })()`);
    console.log('     ' + geo);
    console.log(`     viewport height = ${vp.height}`);
  }

  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
