# quiklip

Clip a long video into short ones — **entirely in your browser**. Nothing is
uploaded, there is no server, no database, no account, and no API key.

Open the video from your device, watch it, tap a big button when a good bit
starts and again when it ends, and export every clip at the end.

**Live:** _(add your Vercel URL here after deploying)_

---

## Why there's no backend

The video never leaves the device. It's opened with the browser's own file API
and cut in-page with [ffmpeg.wasm](https://ffmpegwasm.netlify.app/). The whole
app is static files, so it hosts free anywhere.

The one trick that makes long videos workable: the source file is **mounted**
into ffmpeg (`WORKERFS`) rather than read into memory. ffmpeg pulls only the byte
ranges it needs straight off the file on disk, so a 2 GB source doesn't have to
fit in RAM — only the clip being written does.

---

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # -> dist/
npm run preview    # serve the built site
npm run verify     # drives a real browser and ffprobes the output (see below)
```

`npm install` pulls the ffmpeg cores; `prepare-core` (which runs automatically
before `dev` and `build`) copies them into `public/ffmpeg/`. They are **not**
committed — they're ~62 MB of binary.

---

## Deploy free on Vercel

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new), **Import** the repo.
3. Leave everything at its default — `vercel.json` already sets the build
   command (`npm run build`), the output directory (`dist`), and the headers.
4. **Deploy.** Your public link appears on the project page and looks like
   `https://quiklip-xxxx.vercel.app`.

No environment variables. No paid add-ons. The free Hobby tier is enough.

### The headers matter

`vercel.json` sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. These make the page
*cross-origin isolated*, which is what unlocks `SharedArrayBuffer` and lets the
app use the **multithreaded** ffmpeg core. Without them it still works, just
several times slower on the single-threaded core.

---

## Honest limits

This is the real trade-off of having no server — worth knowing before you send
the link to someone.

- **The first visit downloads ~31 MB** (the ffmpeg engine). It's cached after
  that, but the first load on mobile data is a real wait.
- **Encoding in a browser is slow.** Roughly 2–4× the clip's own length on a
  laptop, and several times worse on a phone. A 30-second clip is fine; batching
  twenty 2-minute clips on a phone is not.
- **Lightning mode is the escape hatch.** It copies the video stream without
  re-encoding, so it finishes in seconds — the catch is cuts snap to the nearest
  keyframe (up to ~2s early) and it can't change the shape or resolution.
- **Phone memory is finite.** Very large sources (multi-GB 4K) can still make a
  mobile browser give up, even with the file mounted rather than loaded.
- **Exported clips live in the tab.** Save the ones you want before closing it.
  Marks and library entries persist in IndexedDB; the finished clips do not.
- **Safari 16.4+** for full support. Chrome and Edge are the happiest.

If you want frame-exact cuts on hour-long files at native speed, the original
local-server version is still in [`legacy-local-server/`](legacy-local-server/) —
it runs real ffmpeg on your own machine with the phone as a remote control.

---

## Layout

```
index.html               app shell
src/main.js              UI + clipping logic
src/engine.js            ffmpeg.wasm: mount, cut, crop/scale
src/store.js             IndexedDB (videos + clip marks)
src/zip.js               dependency-free ZIP writer (store, no deflate)
scripts/prepare-core.mjs copies ffmpeg cores out of node_modules
scripts/verify.mjs       end-to-end browser verification
vercel.json              build config + isolation headers
legacy-local-server/     the original Mac-side ffmpeg version
```

## Verifying a change

```bash
npm run build && npm run verify
```

Serves `dist/` with production headers, drives headless Chromium, pushes a real
video into the file input, marks clips at known timestamps, runs the export,
pulls the resulting blobs back out to disk, and **ffprobes them** to confirm the
durations and dimensions match what was asked for. Screenshots land in
`.cache/verify/`.
