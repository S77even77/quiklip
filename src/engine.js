/**
 * quiklip engine — cuts video entirely inside the browser with ffmpeg.wasm.
 *
 * The one thing that makes long-form viable: the source File is *mounted*
 * (WORKERFS) rather than written into the wasm filesystem. ffmpeg then reads
 * byte ranges lazily straight off the File on disk, so a 2 GB source never
 * has to fit in wasm memory — only the clip being written does.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';

const MOUNT = '/src';

export const ASPECTS = {
  original: null,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Crop + scale filter chain, computed from the video's *displayed* dimensions. */
export function buildVideoFilter({ width: w, height: h }, aspectKey, focus, cap) {
  const target = ASPECTS[aspectKey] ?? null;
  const filters = [];
  if (!w || !h) return { filters: [], w: 0, h: 0 };

  if (target) {
    const src = w / h;
    let cw = w;
    let ch = h;
    if (src > target) {
      cw = even(h * target);
      ch = even(h);
    } else if (src < target) {
      cw = even(w);
      ch = even(w / target);
    }
    cw = Math.min(cw, w);
    ch = Math.min(ch, h);
    const f = focus === 'left' ? 0 : focus === 'right' ? 1 : 0.5;
    const x = Math.max(0, Math.round((w - cw) * f));
    const y = Math.max(0, Math.round((h - ch) * (src < target ? f : 0.5)));
    if (cw !== w || ch !== h) filters.push(`crop=${cw}:${ch}:${x}:${y}`);
    w = cw;
    h = ch;
  }

  // Cap applies to the SHORT side: 1080 -> 1080x1920 vertical, 1920x1080 landscape.
  if (cap) {
    const shortSide = Math.min(w, h);
    if (shortSide > cap) {
      const k = cap / shortSide;
      const nw = even(w * k);
      const nh = even(h * k);
      filters.push(`scale=${nw}:${nh}:flags=bicubic`);
      w = nw;
      h = nh;
    }
  }
  return { filters, w, h };
}

export function buildArgs({ inputPath, outPath, start, end, settings, info }) {
  const dur = Math.max(0.05, end - start);
  const args = ['-nostdin'];
  // Input-side seek: ffmpeg jumps straight to the byte offset instead of
  // decoding from zero — this is what keeps a cut at 01:40:00 fast.
  args.push('-ss', start.toFixed(3), '-i', inputPath, '-t', dur.toFixed(3));

  if (settings.quality === 'copy') {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts');
  } else {
    const crf = settings.quality === 'high' ? 20 : 24;
    const preset = settings.quality === 'high' ? 'veryfast' : 'ultrafast';
    const { filters } = buildVideoFilter(info, settings.aspect, settings.focus, settings.cap);
    if (filters.length) args.push('-vf', filters.join(','));
    // -threads 1 is REQUIRED, not an optimisation: libx264 inside the
    // multithreaded wasm core deadlocks after the first frame when it tries to
    // spin up its own worker threads. Single-threaded encoding is slower but
    // actually finishes. (Copy mode is unaffected and stays fast.)
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '1');
    // Always specify the audio codec rather than detecting first: with no -map,
    // ffmpeg simply ignores these if the source has no audio track. Detecting
    // "has audio" from a <video> element is unreliable across browsers.
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  args.push('-movflags', '+faststart', '-y', outPath);
  return args;
}

/* ------------------------------------------------------------------ engine */

let ffmpeg = null;
let loading = null;
let mountedFile = null;

export const isIsolated = () => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

/**
 * Load the wasm core once. ~31 MB, cached by the browser after the first visit.
 * onProgress reports the download so the UI never looks frozen.
 */
export function loadEngine(onProgress) {
  if (ffmpeg) return Promise.resolve(ffmpeg);
  if (loading) return loading;

  loading = (async () => {
    const mt = isIsolated();
    const base = mt ? '/ffmpeg/mt' : '/ffmpeg/st';
    const abs = (p) => new URL(p, location.origin).href;

    // Stream the big core once so the UI can show a real percentage. This also
    // warms the HTTP cache, so ffmpeg's own request for it is served locally.
    //
    // IMPORTANT: we hand ffmpeg the real HTTP URLs, NOT blob: URLs. The
    // multithreaded core spawns pthread workers that resolve their script
    // path RELATIVE to the core URL — and a blob: URL has no directory, so
    // every worker fails with ERR_FILE_NOT_FOUND and load() hangs forever.
    const res = await fetch(abs(`${base}/ffmpeg-core.wasm`));
    if (!res.ok) throw new Error(`Could not fetch the video engine (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (total && onProgress) onProgress(Math.min(1, got / total));
    }

    const cfg = {
      coreURL: abs(`${base}/ffmpeg-core.js`),
      wasmURL: abs(`${base}/ffmpeg-core.wasm`),
    };
    if (mt) cfg.workerURL = abs(`${base}/ffmpeg-core.worker.js`);

    const inst = new FFmpeg();
    await inst.load(cfg);
    ffmpeg = inst;
    return inst;
  })();

  loading.catch(() => { loading = null; });
  return loading;
}

export function engineReady() {
  return !!ffmpeg;
}

/** Mount the source File so ffmpeg can read it without loading it into memory. */
async function ensureMounted(file) {
  const ff = ffmpeg;
  if (mountedFile === file) return `${MOUNT}/${file.name}`;
  if (mountedFile) {
    try { await ff.unmount(MOUNT); } catch {}
    mountedFile = null;
  }
  try { await ff.createDir(MOUNT); } catch { /* already exists */ }
  await ff.mount('WORKERFS', { files: [file] }, MOUNT);
  mountedFile = file;
  return `${MOUNT}/${file.name}`;
}

export async function unmountAll() {
  if (ffmpeg && mountedFile) {
    try { await ffmpeg.unmount(MOUNT); } catch {}
    mountedFile = null;
  }
}

/**
 * Cut one clip. Returns { blob, name, bytes }.
 * onProgress(0..1) fires while encoding.
 */
export async function cutClip({ file, info, clip, settings, outName, onProgress, onLog }) {
  const ff = await loadEngine();
  const inputPath = await ensureMounted(file);
  const outPath = `/out-${Date.now()}-${Math.round(performance.now())}.mp4`;

  const dur = Math.max(0.05, clip.end - clip.start);
  const handleProgress = ({ progress }) => {
    if (onProgress && Number.isFinite(progress)) onProgress(Math.max(0, Math.min(1, progress)));
  };
  const handleLog = ({ message }) => { if (onLog) onLog(message); };

  ff.on('progress', handleProgress);
  if (onLog) ff.on('log', handleLog);

  try {
    const args = buildArgs({ inputPath, outPath, start: clip.start, end: clip.end, settings, info });
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const data = await ff.readFile(outPath);
    if (!data || !data.length) throw new Error('ffmpeg produced an empty file');
    const blob = new Blob([data.buffer ?? data], { type: 'video/mp4' });
    try { await ff.deleteFile(outPath); } catch {}
    return { blob, name: outName, bytes: blob.size, duration: dur };
  } finally {
    ff.off('progress', handleProgress);
    if (onLog) ff.off('log', handleLog);
  }
}
