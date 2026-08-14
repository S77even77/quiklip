/* quiklip — 100% client-side. No server, no upload, no account. */
'use strict';

import './style.css';
import { cutClip, loadEngine, engineReady, isIsolated, unmountAll, buildVideoFilter } from './engine.js';
import { makeZip } from './zip.js';
import * as store from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  screen: 'library',
  lib: [],
  rec: null,            // current library row {id, file, meta}
  url: null,            // object URL for the current video
  info: null,           // { width, height, duration }
  clips: [],
  armed: null,
  editing: null,
  previewStop: null,
  exports: [],          // { name, blob, url, bytes, duration }
  cancel: false,
  running: false,
  wakeLock: null,
  settings: { offset: 0.5, tail: 0.3, wake: true },
  exp: { aspect: 'original', focus: 'center', quality: 'standard', cap: 720 },
};

/* ─────────────────────────────────────────────────────────── helpers */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtMs = (t) => `${fmt(t)}.${Math.floor((Math.abs(t) % 1) * 10)}`;
const fmtDur = (s) => (s < 60 ? `${s.toFixed(1)}s` : fmt(s));
function fmtBytes(b) {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'clip';

let toastT;
function toast(msg, good) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${good ? ' good' : ''}`;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), 2400);
}

/* ─────────────────────────────────────────────────────────── navigation */

function go(name) {
  if (name === 'clip' && !S.rec) { toast('Pick a video first'); name = 'library'; }
  if (S.screen === 'record' && name !== 'record') teardownCamera();
  S.screen = name;
  $$('.screen').forEach((el) => (el.hidden = el.dataset.screen !== name));
  const tab = name === 'export' ? 'clip' : name;
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.go === tab));
  if (name !== 'clip' && name !== 'export') pause();
  if (name === 'exports') renderExports();
  if (name === 'library') loadLibrary();
}
$$('#tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
$('#btn-back-lib').addEventListener('click', () => go('library'));
$('#btn-back-clip').addEventListener('click', () => go('clip'));
$('#btn-back-record').addEventListener('click', () => go('library'));

/* ─────────────────────────────────────────────────────────── library */

/** Read duration/dimensions straight off a video element — no server probe. */
function probeFile(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (val, err) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      err ? reject(err) : resolve(val);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () =>
      done({
        // videoWidth/Height are already rotation-corrected by the browser.
        width: v.videoWidth,
        height: v.videoHeight,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
      });
    v.onerror = () => done(null, new Error('This file could not be read as video'));
    setTimeout(() => done(null, new Error('Timed out reading this video')), 20000);
    v.src = url;
  });
}

/** Grab a poster frame with a canvas — replaces the server thumbnailer. */
function thumbFile(file, meta) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(val);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => { v.currentTime = Math.min(3, (meta?.duration || v.duration || 4) / 3); };
    v.onseeked = () => {
      try {
        const w = 240;
        const h = Math.max(1, Math.round(w * ((v.videoHeight || 9) / (v.videoWidth || 16))));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        done(c.toDataURL('image/jpeg', 0.7));
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 12000);
    v.src = url;
  });
}

async function loadLibrary() {
  const box = $('#library-list');
  try {
    const rows = await store.listVideos();
    S.lib = rows;
    $('#lib-count').textContent = rows.length ? `(${rows.length})` : '';
    if (!rows.length) {
      box.innerHTML = `<p class="empty">Nothing here yet. Tap <b>Add a video</b> above to get started.</p>`;
      return;
    }
    box.innerHTML = '';
    for (const r of rows) {
      const marks = await store.getMarks(r.id);
      const n = (marks.clips || []).length;
      const el = document.createElement('div');
      el.className = 'vid-card';
      el.innerHTML = `
        <div class="vc-thumb-wrap"><img class="vc-thumb" alt=""></div>
        <div class="vc-meta">
          <div class="vc-name">${esc(r.name)}</div>
          <div class="vc-sub">
            <span class="pill">${fmt(r.meta?.duration || 0)}</span>
            ${r.meta?.width ? `<span class="pill">${r.meta.width}×${r.meta.height}</span>` : ''}
            <span>${fmtBytes(r.size)}</span>
            ${n ? `<span class="pill ok">${n} clip${n > 1 ? 's' : ''} saved</span>` : ''}
          </div>
        </div>
        <button class="vc-del" aria-label="Remove">✕</button>
        <div class="vc-go">›</div>`;
      el.querySelector('.vc-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await store.deleteVideo(r.id);
        toast('Removed from library');
        loadLibrary();
      });
      el.addEventListener('click', () => openVideo(r));
      box.appendChild(el);
      thumbFile(r.file, r.meta).then((src) => { if (src) el.querySelector('.vc-thumb').src = src; });
    }
  } catch (e) {
    box.innerHTML = `<p class="empty">Couldn't read local storage: ${esc(e.message)}</p>`;
  }
}
$('#btn-refresh').addEventListener('click', loadLibrary);

/* ── adding a file ── */
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await addFile(f);
});

async function addFile(file) {
  toast('Reading video…');
  let meta;
  try {
    meta = await probeFile(file);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (!meta.duration) toast('Warning: could not read this video’s length');
  try {
    await store.saveVideo(file, meta);
  } catch (err) {
    // Quota or private-mode failure — still usable this session.
    toast('Too large to remember — usable now, gone on reload');
    const rec = { id: store.fileId(file), name: file.name, size: file.size, file, meta };
    S.lib.unshift(rec);
    openVideo(rec);
    return;
  }
  await loadLibrary();
  const rec = (await store.listVideos()).find((r) => r.id === store.fileId(file));
  if (rec) openVideo(rec);
}

// Drag & drop on desktop.
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('video')) addFile(f);
});

/* ─────────────────────────────────────────────────────────── camera / record */
// Recording is ephemeral, per-session state — deliberately kept out of S so a
// half-finished recording never gets treated as app state to persist/restore.
const CAM = {
  stream: null,            // raw getUserMedia stream (camera + mic hardware)
  recordStream: null,      // what MediaRecorder actually records — the raw stream
  recorder: null,          // MediaRecorder for the CURRENT segment
  mimeType: '', ext: '.webm',
  pendingFinal: false,     // true = the segment about to stop is the whole session ending
  segIndex: 0,             // count of quick-clips saved this session
  startedAt: 0, pausedAccum: 0, pauseStartedAt: 0, timerId: null,
  facing: 'environment', micMuted: false, blob: null, multiCam: false,
  zoom: 1, zoomHideT: null,
};
const MAX_ZOOM = 4;

const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const camPreview = $('#cam-preview');

/**
 * Zoom is a live CSS transform on the preview video, not baked into the
 * recorded file. An earlier version composited every frame onto a canvas
 * (hidden source video -> canvas -> captureStream()) so zoom would carry
 * into the saved clip, but a hidden/near-zero-size <video> is a well-known
 * way to get frame decoding throttled or stopped entirely on iOS Safari —
 * which reads as exactly what got reported: recording turns solid black.
 * A CSS transform on an already-visible, already-working video element has
 * none of that risk, at the cost of zoom being preview-only.
 */
function applyPreviewTransform() {
  const mirror = CAM.facing === 'user' ? 'scaleX(-1) ' : '';
  camPreview.style.transform = `${mirror}scale(${CAM.zoom})`;
}

function setZoom(z) {
  CAM.zoom = clamp(z, 1, MAX_ZOOM);
  applyPreviewTransform();
  $('#cam-zoom-ind').hidden = false;
  $('#cam-zoom-val').textContent = `${CAM.zoom.toFixed(1)}×`;
  clearTimeout(CAM.zoomHideT);
  CAM.zoomHideT = setTimeout(() => { $('#cam-zoom-ind').hidden = true; }, 1200);
}

// Two-finger pinch on the camera preview. Distance ratio since pinch start,
// applied to the zoom level at that moment — standard camera-app pinch feel.
const camWrap = $('#cam-wrap');
const activeTouches = new Map();
let pinchBase = null;
const touchDist = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
camWrap.addEventListener('pointerdown', (e) => {
  activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activeTouches.size === 2) pinchBase = { dist: touchDist([...activeTouches.values()]), zoom: CAM.zoom };
});
camWrap.addEventListener('pointermove', (e) => {
  if (!activeTouches.has(e.pointerId)) return;
  activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activeTouches.size === 2 && pinchBase) {
    const dist = touchDist([...activeTouches.values()]);
    setZoom(pinchBase.zoom * (dist / pinchBase.dist));
  }
});
const endTouch = (e) => { activeTouches.delete(e.pointerId); if (activeTouches.size < 2) pinchBase = null; };
camWrap.addEventListener('pointerup', endTouch);
camWrap.addEventListener('pointercancel', endTouch);

/** First mimeType the browser can both record AND that ffmpeg.wasm can decode. */
function pickRecorderMime() {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',   // Safari 16.4+
    'video/mp4',
    'video/webm;codecs=vp9,opus',        // Chrome/Edge/Firefox
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

$('#btn-add-open').addEventListener('click', () => openSheet('#sheet-add'));
$('#opt-choose').addEventListener('click', () => { closeSheets(); $('#file-input').click(); });
$('#opt-record').addEventListener('click', () => {
  closeSheets();
  if (!canRecord()) return toast('Camera recording needs a supported browser (Chrome, Safari 16.4+) over HTTPS');
  go('record');
  startCamera();
});
$('#btn-cam-retry').addEventListener('click', startCamera);

async function startCamera() {
  $('#cam-error').hidden = true;
  $('#cam-review').hidden = true;
  $('#cam-controls-live').hidden = false;
  $('#rec-status-sub').textContent = 'Starting camera…';
  CAM.zoom = 1;
  $('#cam-zoom-ind').hidden = true;
  stopCameraStream();

  // Try progressively looser constraints — a resolution or facingMode the
  // device can't honor should degrade gracefully, not dead-end the feature.
  const attempts = [
    { video: { facingMode: { ideal: CAM.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: true, noiseSuppression: true } },
    { video: { facingMode: { ideal: CAM.facing } }, audio: true },
    { video: true, audio: true },
  ];

  let stream = null;
  let lastErr = null;
  for (const constraints of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; }
    catch (e) { lastErr = e; }
  }
  if (!stream) return showCamError(lastErr);

  CAM.stream = stream;
  camPreview.srcObject = stream;
  // Call play() explicitly rather than relying solely on the autoplay
  // attribute — more reliable across Safari versions for a JS-assigned
  // srcObject, especially after the element has already been used once.
  camPreview.play().catch(() => {});
  applyPreviewTransform();
  if (CAM.micMuted) stream.getAudioTracks().forEach((t) => (t.enabled = false));
  $('#rec-status-sub').textContent = 'Ready';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    CAM.multiCam = devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch { CAM.multiCam = false; }
  $('#btn-flip-camera').hidden = !CAM.multiCam;
}

function showCamError(err) {
  const map = {
    NotAllowedError: 'Camera access was denied. Allow camera & microphone access for this site in your browser settings, then try again.',
    PermissionDeniedError: 'Camera access was denied. Allow camera & microphone access for this site, then try again.',
    NotFoundError: 'No camera was found on this device.',
    DevicesNotFoundError: 'No camera was found on this device.',
    NotReadableError: 'Your camera is already in use by another app.',
    TrackStartError: 'Your camera is already in use by another app.',
    OverconstrainedError: 'This camera does not support the requested settings.',
  };
  $('#cam-error-msg').textContent = map[err?.name] || err?.message || 'Could not access the camera.';
  $('#cam-error').hidden = false;
  $('#cam-controls-live').hidden = true;
  $('#rec-status-sub').textContent = 'Camera unavailable';
}

function stopCameraStream() {
  CAM.stream?.getTracks().forEach((t) => t.stop());
  CAM.stream = null;
  camPreview.srcObject = null;
}

/** Full teardown when leaving the record screen by any route (tab, back, etc). */
function teardownCamera() {
  if (CAM.recorder && CAM.recorder.state !== 'inactive') {
    CAM.recorder.onstop = null; // leaving — don't pop the review sheet or continue segments
    try { CAM.recorder.stop(); } catch {}
  }
  endRecordingUI();
  CAM.zoom = 1;
  $('#cam-zoom-ind').hidden = true;
  const pv = $('#cam-playback');
  if (pv?.src) URL.revokeObjectURL(pv.src);
  if (pv) { pv.removeAttribute('src'); pv.hidden = true; }
  CAM.blob = null;
}

$('#btn-flip-camera').addEventListener('click', () => {
  if (CAM.recorder && CAM.recorder.state !== 'inactive') return; // no flip mid-recording
  CAM.facing = CAM.facing === 'user' ? 'environment' : 'user';
  startCamera();
});

$('#btn-mute-mic').addEventListener('click', () => {
  CAM.micMuted = !CAM.micMuted;
  CAM.stream?.getAudioTracks().forEach((t) => (t.enabled = !CAM.micMuted));
  $('#btn-mute-mic').classList.toggle('off', CAM.micMuted);
  $('#btn-mute-mic').textContent = CAM.micMuted ? '🔇' : '🎙️';
});

$('#btn-record-toggle').addEventListener('click', () => {
  if (!CAM.stream) return;
  if (!CAM.recorder || CAM.recorder.state === 'inactive') startRecording();
  else stopRecording();
});

$('#btn-pause-rec').addEventListener('click', () => {
  if (!CAM.recorder) return;
  if (CAM.recorder.state === 'recording') {
    CAM.recorder.pause();
    CAM.pauseStartedAt = performance.now();
    $('#btn-pause-rec').textContent = '▶';
    $('#cam-timer').classList.add('paused');
  } else if (CAM.recorder.state === 'paused') {
    CAM.recorder.resume();
    CAM.pausedAccum += performance.now() - CAM.pauseStartedAt;
    $('#btn-pause-rec').textContent = '❚❚';
    $('#cam-timer').classList.remove('paused');
  }
});

/**
 * One segment = one MediaRecorder run. A quick-clip tap stops the current
 * segment (which finalizes it as a real, independently playable clip — you
 * can't validly slice a still-running recorder's output any other way) and
 * immediately starts the next one on the same live stream, so the camera
 * feed and the on-screen timer never visibly pause.
 */
/** Shared cleanup for "recording is fully over" — normal stop AND error paths. */
function endRecordingUI() {
  clearInterval(CAM.timerId);
  CAM.recordStream = null;
  stopCameraStream();
  $('#btn-record-toggle').classList.remove('on');
  $('#btn-quick-clip').hidden = true;
  $('#btn-pause-rec').hidden = true;
  $('#cam-timer').hidden = true;
}

function beginSegment() {
  const chunks = [];
  let recorder;
  try { recorder = new MediaRecorder(CAM.recordStream, { mimeType: CAM.mimeType }); }
  catch { recorder = new MediaRecorder(CAM.recordStream); } // let the browser pick
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: CAM.mimeType || 'video/webm' });
    if (CAM.pendingFinal) {
      endRecordingUI();
      CAM.blob = blob;
      showReview(blob); // the tail end (or the whole take) still gets the full editor
    } else {
      finalizeSegment(blob);
      // Starting the next segment can itself fail on a flaky device — if it
      // does, the clips already saved are NOT lost; just end the session
      // cleanly instead of leaving the UI stuck mid-recording.
      try { beginSegment(); }
      catch (e) {
        console.warn('[quiklip] could not continue recording after quick-clip:', e);
        toast('Recording stopped — your clips are saved');
        endRecordingUI();
        $('#rec-status-sub').textContent = 'Ready';
      }
    }
  };
  recorder.start(1000); // 1s timeslice bounds memory on long segments
  CAM.recorder = recorder;
}

/** A quick-clip tap: send this segment straight to the Clips tab, ready to use. */
function finalizeSegment(blob) {
  if (blob.size < 2000) { toast('Clip too short — not saved'); return; }
  CAM.segIndex += 1;
  const stamp = new Date();
  const name = `clip-${stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${CAM.segIndex}${CAM.ext}`;
  const url = URL.createObjectURL(blob);
  S.exports.unshift({ name, blob, url, bytes: blob.size, duration: null, source: 'recording' });
  if (S.screen === 'exports') renderExports();
  toast(`Clip saved to Clips · ${fmtBytes(blob.size)}`, true);
}

function startRecording() {
  const mime = pickRecorderMime();
  if (!mime) { toast('This browser cannot record video'); return; }
  CAM.mimeType = mime;
  CAM.ext = mime.includes('mp4') ? '.mp4' : '.webm';
  CAM.segIndex = 0;
  CAM.pendingFinal = false;
  CAM.pausedAccum = 0;

  // Record the raw camera stream directly — the proven-reliable path. Zoom is
  // a preview-only CSS transform (see applyPreviewTransform), so it never has
  // to touch what actually gets encoded.
  CAM.recordStream = CAM.stream;

  try {
    beginSegment();
  } catch (e) {
    toast(`Could not start recording: ${e.message || e}`);
    CAM.recordStream = null;
    return;
  }
  CAM.startedAt = performance.now();

  $('#btn-record-toggle').classList.add('on');
  $('#btn-quick-clip').hidden = false;
  $('#btn-pause-rec').hidden = false;
  $('#btn-pause-rec').textContent = '❚❚';
  $('#btn-flip-camera').hidden = true;
  $('#cam-timer').hidden = false;
  $('#cam-timer').classList.remove('paused');
  $('#rec-status-sub').textContent = 'Recording…';
  buzz(20);

  // Spans the WHOLE session, not just one segment — a quick-clip tap must not
  // reset the on-screen clock, since the recording itself never stopped.
  CAM.timerId = setInterval(() => {
    const elapsed = (performance.now() - CAM.startedAt - CAM.pausedAccum) / 1000;
    $('#cam-timer-txt').textContent = fmt(Math.max(0, elapsed));
  }, 250);
}

function stopRecording() {
  if (!CAM.recorder || CAM.recorder.state === 'inactive') return;
  CAM.pendingFinal = true;
  CAM.recorder.stop();
  $('#cam-controls-live').hidden = true;
  buzz([15, 40, 15]);
}

$('#btn-quick-clip').addEventListener('click', () => {
  if (!CAM.recorder || CAM.recorder.state === 'inactive') return;
  CAM.recorder.stop(); // pendingFinal is false, so onstop finalizes + continues
  buzz([12, 40, 12]);
  const b = $('#btn-quick-clip');
  b.classList.add('pulse');
  setTimeout(() => b.classList.remove('pulse'), 260);
});

function showReview(blob) {
  const url = URL.createObjectURL(blob);
  const pv = $('#cam-playback');
  pv.hidden = false;
  pv.src = url;
  // Wait for real metadata before painting the review sheet, so it never
  // flashes "Recorded 0:00" for the split second before duration is known.
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    $('#cam-review-dur').textContent = fmt(pv.duration || 0);
    $('#cam-review').hidden = false;
    $('#rec-status-sub').textContent = 'Review your recording';
    pv.play().catch(() => {});
  };
  pv.onloadedmetadata = reveal;
  setTimeout(reveal, 1200); // local blob — should be instant; safety net only
}

$('#btn-retake').addEventListener('click', () => {
  const pv = $('#cam-playback');
  if (pv.src) URL.revokeObjectURL(pv.src);
  pv.removeAttribute('src');
  pv.hidden = true;
  CAM.blob = null;
  $('#cam-review').hidden = true;
  $('#cam-controls-live').hidden = false;
  startCamera();
});

$('#btn-use-recording').addEventListener('click', async () => {
  if (!CAM.blob) return;
  const stamp = new Date();
  const name = `recording-${stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-')}${CAM.ext}`;
  const file = new File([CAM.blob], name, { type: CAM.mimeType || 'video/webm', lastModified: stamp.getTime() });
  const pv = $('#cam-playback');
  if (pv.src) URL.revokeObjectURL(pv.src);
  pv.removeAttribute('src');
  pv.hidden = true;
  CAM.blob = null;
  await addFile(file); // reuses the exact same pipeline as an uploaded file
});

/* ─────────────────────────────────────────────────────────── open video */

const video = $('#video');

async function openVideo(rec) {
  S.rec = rec;
  S.armed = null;
  S.clips = [];
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(rec.file);
  S.info = rec.meta || { width: 0, height: 0, duration: 0 };

  $('#clip-title').textContent = rec.name;
  $('#clip-sub').textContent = S.info.width
    ? `${fmt(S.info.duration)} · ${S.info.width}×${S.info.height}`
    : fmt(S.info.duration);
  video.src = S.url;
  video.playbackRate = 1;
  setRateButtons(1);
  go('clip');

  const marks = await store.getMarks(rec.id);
  if (marks.clips?.length) {
    S.clips = marks.clips;
    toast(`Restored ${marks.clips.length} saved clip${marks.clips.length > 1 ? 's' : ''}`, true);
  }
  if (marks.settings) Object.assign(S.exp, marks.settings);
  renderClips();
  syncExportChips();
  requestWake();

  // Warm the engine in the background so Export isn't a cold start.
  primeEngine();
}

/* ─────────────────────────────────────────────────────── playback */

const play = () => video.play().catch(() => {});
const pause = () => video.pause();
const togglePlay = () => (video.paused ? play() : pause());

$('#tap-layer').addEventListener('click', togglePlay);
$('#btn-play').addEventListener('click', togglePlay);
video.addEventListener('play', () => {
  $('#tap-layer').classList.remove('paused');
  $('#btn-play').textContent = '❚❚';
  requestWake();
});
video.addEventListener('pause', () => {
  $('#tap-layer').classList.add('paused');
  $('#btn-play').textContent = '▶';
});
video.addEventListener('loadedmetadata', () => {
  $('#tap-layer').classList.add('paused');
  if (!S.info?.width) {
    S.info = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    $('#clip-sub').textContent = `${fmt(video.duration)} · ${video.videoWidth}×${video.videoHeight}`;
  }
  paintTime();
  drawTimeline();
});
video.addEventListener('durationchange', paintTime);

$$('[data-seek]').forEach((b) =>
  b.addEventListener('click', () => {
    video.currentTime = clamp(video.currentTime + Number(b.dataset.seek), 0, video.duration || 0);
    buzz(8);
  })
);
$$('#speed-row button').forEach((b) =>
  b.addEventListener('click', () => {
    video.playbackRate = Number(b.dataset.rate);
    setRateButtons(Number(b.dataset.rate));
  })
);
const setRateButtons = (r) =>
  $$('#speed-row button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === r));

/* ─────────────────────────────────────────────────────── timeline */

const track = $('#tl-track');

function paintTime() {
  const d = video.duration || S.info?.duration || 0;
  const t = video.currentTime || 0;
  $('#t-cur').textContent = fmt(t);
  $('#t-rem').textContent = `-${fmt(Math.max(0, d - t))}`;
  $('#t-dur').textContent = fmt(d);
  const pct = d ? (t / d) * 100 : 0;
  $('#tl-head').style.left = `${pct}%`;
  $('#tl-played').style.width = `${pct}%`;
}

video.addEventListener('timeupdate', () => {
  const d = video.duration || 0;
  const t = video.currentTime;
  paintTime();

  if (S.armed) {
    const len = Math.max(0, t - S.armed.start);
    $('#armed-dur').textContent = fmtDur(len);
    const live = document.getElementById('open-clip-dur');
    if (live) live.textContent = fmtDur(len);
    const a = $('#tl-armed');
    a.hidden = false;
    a.style.left = `${(S.armed.start / d) * 100}%`;
    a.style.width = `${Math.max(0.4, ((t - S.armed.start) / d) * 100)}%`;
  }

  if (S.previewStop != null && t >= S.previewStop) {
    S.previewStop = null;
    pause();
  }
});

function drawTimeline() {
  const d = video.duration || S.info?.duration || 0;
  if (!d) return;
  $('#tl-clips').innerHTML = S.clips
    .map((c) => `<i style="left:${(c.start / d) * 100}%;width:${Math.max(0.4, ((c.end - c.start) / d) * 100)}%"></i>`)
    .join('');
}

let scrubbing = false;
const seekFromEvent = (e) => {
  const r = track.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const d = video.duration || 0;
  if (d) video.currentTime = clamp((x / r.width) * d, 0, d);
};
track.addEventListener('pointerdown', (e) => { scrubbing = true; track.setPointerCapture(e.pointerId); seekFromEvent(e); });
track.addEventListener('pointermove', (e) => { if (scrubbing) seekFromEvent(e); });
track.addEventListener('pointerup', () => (scrubbing = false));
track.addEventListener('pointercancel', () => (scrubbing = false));

/* ────────────────────────────────────────── the mark button */

$('#btn-mark').addEventListener('click', () => {
  if (!S.rec) return toast('Open a video first');
  const d = video.duration || 0;
  if (!d) return toast('Video still loading…');

  if (!S.armed) {
    S.armed = { start: clamp(video.currentTime - S.settings.offset, 0, d) };
    setArmedUI(true);
    buzz(18);
    if (video.paused) play();
  } else {
    const end = clamp(video.currentTime + S.settings.tail, 0, d);
    const start = S.armed.start;
    S.armed = null;
    setArmedUI(false);
    if (end - start < 0.3) { toast('Too short — discarded'); drawTimeline(); return; }
    S.clips.push({ name: `Clip ${S.clips.length + 1}`, start, end });
    S.clips.sort((a, b) => a.start - b.start);
    buzz([12, 40, 12]);
    toast(`Clip banked · ${fmtDur(end - start)}`, true);
    renderClips();
    saveMarks();
  }
});
$('#btn-cancel-mark').addEventListener('click', () => {
  S.armed = null;
  setArmedUI(false);
  toast('Discarded');
});

function setArmedUI(on) {
  $('#btn-mark').classList.toggle('armed', on);
  $('.player-wrap').classList.toggle('armed', on);
  $('#mk-ico').textContent = on ? '■' : '●';
  $('#mk-txt').textContent = on ? 'END CLIP' : 'START CLIP';
  $('#mk-hint').textContent = on ? 'tap again when it ends' : 'tap when the good part begins';
  $('#armed-badge').hidden = !on;
  $('#btn-cancel-mark').hidden = !on;
  if (!on) $('#tl-armed').hidden = true;
  renderClips();
}

/* ─────────────────────────────────────────────────────── clip list */

function renderClips() {
  const box = $('#clip-list');
  $('#clip-count').textContent = S.clips.length;
  $('#btn-goto-export').disabled = !S.clips.length;
  drawTimeline();

  if (!S.clips.length && !S.armed) {
    box.innerHTML = `<p class="empty">No clips yet. Play the video and tap <b>START CLIP</b> when something good begins, then tap again to end it. The video never pauses.</p>`;
    return;
  }
  box.innerHTML = '';

  if (S.armed) {
    const open = document.createElement('div');
    open.className = 'clip-row open';
    open.innerHTML = `
      <span class="cr-n"><span class="cr-live"></span></span>
      <span class="cr-meta">
        <span class="cr-name">Recording…</span>
        <span class="cr-time">${fmt(S.armed.start)} → open</span>
      </span>
      <span class="cr-dur" id="open-clip-dur">0.0s</span>`;
    box.appendChild(open);
  }

  S.clips.forEach((c, i) => {
    const row = document.createElement('button');
    row.className = 'clip-row';
    row.innerHTML = `
      <span class="cr-n">${i + 1}</span>
      <span class="cr-meta">
        <span class="cr-name">${esc(c.name)}</span>
        <span class="cr-time">${fmt(c.start)} → ${fmt(c.end)}</span>
      </span>
      <span class="cr-dur">${fmtDur(c.end - c.start)}</span>
      <span class="cr-edit">✎</span>`;
    row.addEventListener('click', () => openClipEditor(i));
    box.appendChild(row);
  });
}

let saveT;
function saveMarks() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!S.rec) return;
    store.saveMarks(S.rec.id, S.clips, S.exp).catch(() => {});
  }, 400);
}

/* ── clip editor ── */
function openClipEditor(i) {
  S.editing = i;
  $('#ec-name').value = S.clips[i].name;
  refreshEditor();
  openSheet('#sheet-clip');
}
function refreshEditor() {
  const c = S.clips[S.editing];
  if (!c) return;
  $('#ec-start').textContent = fmtMs(c.start);
  $('#ec-end').textContent = fmtMs(c.end);
  $('#ec-dur').textContent = fmtDur(c.end - c.start);
}
$$('[data-nudge]').forEach((b) =>
  b.addEventListener('click', () => {
    const [field, amt] = b.dataset.nudge.split(',');
    const c = S.clips[S.editing];
    if (!c) return;
    const d = video.duration || S.info?.duration || 1e9;
    const next = clamp(c[field] + Number(amt), 0, d);
    if (field === 'start' && next >= c.end - 0.2) return;
    if (field === 'end' && next <= c.start + 0.2) return;
    c[field] = next;
    video.currentTime = next;
    refreshEditor();
    drawTimeline();
    buzz(6);
  })
);
$('#ec-preview').addEventListener('click', () => {
  const c = S.clips[S.editing];
  if (!c) return;
  closeSheets();
  video.currentTime = c.start;
  S.previewStop = c.end;
  play();
  toast(`Previewing ${fmtDur(c.end - c.start)}`);
});
$('#ec-done').addEventListener('click', () => {
  const c = S.clips[S.editing];
  if (c) c.name = $('#ec-name').value.trim() || c.name;
  S.clips.sort((a, b) => a.start - b.start);
  closeSheets();
  renderClips();
  saveMarks();
});
$('#ec-delete').addEventListener('click', () => {
  S.clips.splice(S.editing, 1);
  closeSheets();
  renderClips();
  saveMarks();
  toast('Clip deleted');
});

/* ─────────────────────────────────────────────────────── settings */

$('#btn-settings').addEventListener('click', () => { refreshSettings(); openSheet('#sheet-settings'); });
$('#sheet-close').addEventListener('click', closeSheets);
function refreshSettings() {
  $('#off-val').textContent = `${S.settings.offset.toFixed(1)}s`;
  $('#tail-val').textContent = `${S.settings.tail.toFixed(1)}s`;
  $('#opt-wake').checked = S.settings.wake;
}
$$('[data-off]').forEach((b) => b.addEventListener('click', () => {
  S.settings.offset = clamp(Math.round((S.settings.offset + Number(b.dataset.off)) * 10) / 10, 0, 5);
  refreshSettings(); persistLocal();
}));
$$('[data-tail]').forEach((b) => b.addEventListener('click', () => {
  S.settings.tail = clamp(Math.round((S.settings.tail + Number(b.dataset.tail)) * 10) / 10, 0, 5);
  refreshSettings(); persistLocal();
}));
$('#opt-wake').addEventListener('change', (e) => {
  S.settings.wake = e.target.checked;
  persistLocal();
  e.target.checked ? requestWake() : releaseWake();
});
const persistLocal = () => { try { localStorage.setItem('quiklip.settings', JSON.stringify(S.settings)); } catch {} };
try { Object.assign(S.settings, JSON.parse(localStorage.getItem('quiklip.settings') || '{}')); } catch {}

async function requestWake() {
  if (!S.settings.wake || S.wakeLock || !('wakeLock' in navigator)) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => (S.wakeLock = null));
  } catch {}
}
const releaseWake = () => { try { S.wakeLock?.release(); } catch {} S.wakeLock = null; };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });

/* ─────────────────────────────────────────────────────── sheets */

function openSheet(sel) { closeSheets(); $('#scrim').hidden = false; $(sel).hidden = false; }
function closeSheets() { $('#scrim').hidden = true; $$('.sheet').forEach((s) => (s.hidden = true)); }
$('#scrim').addEventListener('click', closeSheets);

/* ─────────────────────────────────────────────────────── engine warm-up */

let primed = false;
async function primeEngine() {
  if (primed || engineReady()) return;
  primed = true;
  const box = $('#engine-box');
  box.hidden = false;
  try {
    await loadEngine((p) => {
      const pct = Math.round(p * 100);
      $('#engine-bar').style.width = `${pct}%`;
      $('#engine-pct').textContent = `${pct}%`;
    });
    $('#engine-label').textContent = `Video engine ready${isIsolated() ? ' (fast mode)' : ''}`;
    $('#engine-pct').textContent = '✓';
    $('#engine-bar').style.width = '100%';
    setTimeout(() => (box.hidden = true), 2500);
  } catch (e) {
    primed = false;
    const msg = e?.message || e?.toString?.() || 'unknown error';
    $('#engine-label').textContent = `Engine failed: ${msg}`;
    console.error('[quiklip] engine load failed', e);
  }
}

/* ─────────────────────────────────────────────────────── export */

$('#btn-goto-export').addEventListener('click', () => {
  if (!S.clips.length) return;
  $('#export-setup').hidden = false;
  $('#export-progress').hidden = true;
  $('#job-done').hidden = true;
  updateExportSummary();
  go('export');
  primeEngine();
});

function bindChips(sel, key, cast = (v) => v) {
  $$(`${sel} button`).forEach((b) =>
    b.addEventListener('click', () => {
      $$(`${sel} button`).forEach((o) => o.classList.remove('on'));
      b.classList.add('on');
      S.exp[key] = cast(b.dataset.v);
      updateExportSummary();
      saveMarks();
    })
  );
}
bindChips('#opt-aspect', 'aspect');
bindChips('#opt-focus', 'focus');
bindChips('#opt-quality', 'quality');
bindChips('#opt-cap', 'cap', Number);

function syncExportChips() {
  const set = (sel, val) => $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v == val));
  set('#opt-aspect', S.exp.aspect);
  set('#opt-focus', S.exp.focus);
  set('#opt-quality', S.exp.quality);
  set('#opt-cap', S.exp.cap);
  updateExportSummary();
}

function updateExportSummary() {
  const n = S.clips.length;
  const total = S.clips.reduce((a, c) => a + (c.end - c.start), 0);
  $('#exp-n').textContent = n;
  $('#exp-sub').textContent = S.rec?.name || '';
  $('#focus-wrap').hidden = S.exp.aspect === 'original' || S.exp.quality === 'copy';

  const copy = S.exp.quality === 'copy';
  const shape = copy ? 'untouched' : S.exp.aspect === 'original' ? 'original shape' : `${S.exp.aspect} · keep ${S.exp.focus}`;
  const res = copy || !S.exp.cap ? 'original resolution' : `${S.exp.cap}p`;
  const out = !copy && S.info?.width ? buildVideoFilter(S.info, S.exp.aspect, S.exp.focus, S.exp.cap) : null;
  const dims = out?.w ? ` → <b>${out.w}×${out.h}</b>` : '';
  const cut = copy
    ? '<b>Cuts snap to keyframes</b> — clips may start up to ~2s early.'
    : 'Cuts are frame-exact.';
  $('#export-summary').innerHTML =
    `<b>${n}</b> clip${n === 1 ? '' : 's'} · <b>${fmtDur(total)}</b> total<br>${shape} · ${res}${dims}<br>${cut}`;

  // Honest expectation-setting: wasm encoding is far slower than native.
  const warn = $('#export-warn');
  if (copy) {
    warn.hidden = false;
    warn.className = 'warn ok';
    warn.innerHTML = 'Lightning mode — this should take only a few seconds.';
  } else {
    // Measured on a laptop at 480p: ~8x realtime for standard, ~2.5x for high.
    // Phones are roughly 3-5x slower again, hence the range.
    const mult = S.exp.quality === 'high' ? 0.4 : 0.13;
    const est = total * mult * (isIsolated() ? 1 : 2.5);
    warn.hidden = false;
    warn.className = est > 180 ? 'warn bad' : 'warn';
    warn.innerHTML = `Rough estimate: <b>${fmt(est)}</b> on a laptop, up to <b>${fmt(est * 4)}</b> on a phone.
      ${est > 180 ? 'Consider <b>Lightning</b>, a lower resolution, or fewer clips. ' : ''}
      Higher resolutions cost a lot more. Keep this tab open while it runs.`;
  }
}

$('#btn-run-export').addEventListener('click', runExport);
$('#btn-cancel-export').addEventListener('click', () => {
  S.cancel = true;
  toast('Stopping after the current clip…');
});

async function runExport() {
  if (S.running) return;
  S.running = true;
  S.cancel = false;
  $('#export-setup').hidden = true;
  $('#export-progress').hidden = false;
  $('#job-done').hidden = true;
  $('#btn-cancel-export').hidden = false;
  $('#ov-bar').style.width = '0%';
  $('#ov-txt').textContent = 'Loading video engine…';
  $('#job-list').innerHTML = '';

  const items = S.clips.map((c, i) => ({
    index: i,
    name: c.name,
    start: c.start,
    end: c.end,
    duration: c.end - c.start,
    status: 'queued',
    pct: 0,
    error: null,
  }));
  items.forEach(renderJobItem);

  const batch = [];
  try {
    await loadEngine((p) => {
      $('#ov-bar').style.width = `${Math.round(p * 100)}%`;
      $('#ov-txt').textContent = `Loading video engine… ${Math.round(p * 100)}%`;
    });

    for (const it of items) {
      if (S.cancel) { it.status = 'queued'; renderJobItem(it); continue; }
      it.status = 'running';
      renderJobItem(it);
      $('#ov-txt').textContent = `Clip ${it.index + 1} of ${items.length} — ${esc(it.name)}`;

      const ext = S.exp.quality === 'copy' ? (S.rec.name.match(/\.(mp4|mov|m4v|webm|mkv)$/i)?.[0] || '.mp4') : '.mp4';
      const outName = `${String(it.index + 1).padStart(2, '0')}-${slug(it.name)}${ext}`;

      try {
        const res = await cutClip({
          file: S.rec.file,
          info: S.info,
          clip: { start: it.start, end: it.end },
          settings: S.exp,
          outName,
          onProgress: (p) => {
            it.pct = Math.round(p * 100);
            renderJobItem(it);
            const overall = items.reduce((a, x) => a + (x.status === 'done' ? 100 : x.status === 'running' ? x.pct : 0), 0) / items.length;
            $('#ov-bar').style.width = `${overall}%`;
          },
        });
        const url = URL.createObjectURL(res.blob);
        const entry = { name: outName, blob: res.blob, url, bytes: res.bytes, duration: it.duration, source: S.rec.name };
        batch.push(entry);
        S.exports.unshift(entry);
        it.status = 'done';
        it.pct = 100;
        it.url = url;
        it.bytes = res.bytes;
      } catch (err) {
        it.status = 'error';
        it.error = String(err.message || err).slice(0, 300);
      }
      renderJobItem(it);
    }

    await unmountAll();

    const ok = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'error').length;
    $('#ov-bar').style.width = '100%';
    $('#ov-txt').textContent = S.cancel
      ? `Stopped — ${ok} clip${ok === 1 ? '' : 's'} finished`
      : failed
        ? `${ok} exported, ${failed} failed`
        : `All ${ok} clip${ok === 1 ? '' : 's'} exported ✓`;
    $('#btn-cancel-export').hidden = true;
    if (ok) {
      $('#job-done').hidden = false;
      $('#btn-zip').onclick = () => downloadZip(batch);
    }
    buzz([20, 60, 20]);
    if (ok) toast('Export complete', true);
  } catch (e) {
    $('#ov-txt').textContent = `Failed: ${e.message}`;
    $('#btn-cancel-export').hidden = true;
  } finally {
    S.running = false;
  }
}

function renderJobItem(it) {
  let row = document.getElementById(`job-${it.index}`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'job-row';
    row.id = `job-${it.index}`;
    $('#job-list').appendChild(row);
  }
  const label = { queued: 'Waiting', running: 'Encoding', done: 'Ready', error: 'Failed' }[it.status] || it.status;
  row.innerHTML = `
    <div class="jr-top">
      <div class="jr-name">${it.index + 1}. ${esc(it.name)} <span class="muted">· ${fmtDur(it.duration)}</span></div>
      <div class="jr-status ${it.status}">${label}</div>
    </div>
    <div class="bar"><i style="width:${it.status === 'done' ? 100 : it.pct}%"></i></div>
    ${it.error ? `<div class="jr-err">${esc(it.error)}</div>` : ''}
    ${it.status === 'done' && it.url ? `<div class="jr-links">
        <a href="${it.url}" target="_blank" rel="noopener">▶ Play</a>
        <a href="${it.url}" download="${esc(it.name)}">⤓ Save${it.bytes ? ` (${fmtBytes(it.bytes)})` : ''}</a>
      </div>` : ''}`;
}

async function downloadZip(list) {
  const files = (list && list.length ? list : S.exports).map((e) => ({ name: e.name, blob: e.blob }));
  if (!files.length) return toast('Nothing to zip');
  toast('Building zip…');
  try {
    const blob = await makeZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quiklip-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) {
    toast(`Zip failed: ${e.message}`);
  }
}

$('#btn-view-exports').addEventListener('click', () => go('exports'));

/* ─────────────────────────────────────────────────────── exports screen */

function renderExports() {
  const box = $('#exports-list');
  if (!S.exports.length) {
    box.innerHTML = `<p class="empty">No clips exported yet. Mark some clips, then hit <b>Export</b>.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="exp-group">
      <div class="eg-head">
        <div>
          <div class="eg-title">This session</div>
          <div class="eg-sub">${S.exports.length} clip${S.exports.length > 1 ? 's' : ''} · ${fmtBytes(S.exports.reduce((a, e) => a + e.bytes, 0))}</div>
        </div>
        <button class="primary sm" id="zip-all">⤓ .zip</button>
      </div>
      <div class="eg-items">
        ${S.exports.map((e, i) => `
          <div class="eg-item">
            <a class="eg-name" href="${e.url}" target="_blank" rel="noopener">${esc(e.name)}</a>
            <span class="eg-size">${fmtBytes(e.bytes)}</span>
            <a class="eg-dl" href="${e.url}" download="${esc(e.name)}">⤓</a>
          </div>`).join('')}
      </div>
      <p class="footnote">Clips live in this tab only — save the ones you want before closing it.</p>
    </div>`;
  $('#zip-all').addEventListener('click', () => downloadZip(S.exports));
}

/* ─────────────────────────────────────────────────────── keys + boot */

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (S.screen !== 'clip') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'm' || e.key === 'M') $('#btn-mark').click();
  else if (e.key === 'ArrowLeft') video.currentTime = clamp(video.currentTime - (e.shiftKey ? 30 : 5), 0, video.duration);
  else if (e.key === 'ArrowRight') video.currentTime = clamp(video.currentTime + (e.shiftKey ? 30 : 5), 0, video.duration);
});

function compatNote() {
  const el = $('#compat-note');
  const bits = [];
  if (typeof WebAssembly === 'undefined') bits.push('This browser has no WebAssembly — exporting will not work.');
  else if (!isIsolated()) bits.push('Running in compatibility mode — exports work but are slower.');
  else bits.push('Fast mode enabled.');
  if (!canRecord()) bits.push('Camera recording needs HTTPS and a supported browser.');
  el.innerHTML = `${bits.join(' ')} Works best in Chrome, Edge, or Safari 16.4+.`;
}

setArmedUI(false);
refreshSettings();
loadLibrary();
compatNote();
if (!canRecord()) $('#opt-record').hidden = true;

// Test seam for scripts/verify.mjs — lets the harness set exact in/out points
// (bypassing the reaction offset) so exports can be checked against known times.
window.__quiklip = {
  addFile,
  get state() { return S; },
  exportsCount: () => S.exports.length,
  setClips(clips, exp) {
    S.clips = clips.map((c) => ({ ...c }));
    if (exp) Object.assign(S.exp, exp);
    renderClips();
    syncExportChips();
  },
  /** Single cut with ffmpeg's own log surfaced — for diagnosing stalls. */
  rawCut({ start, end, settings, onLog }) {
    return cutClip({
      file: S.rec.file,
      info: S.info,
      clip: { start, end },
      settings,
      outName: 'diag.mp4',
      onProgress: () => {},
      onLog,
    });
  },
};
