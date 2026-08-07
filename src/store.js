/**
 * Local persistence — IndexedDB only. Nothing leaves the device.
 *
 * videos: the actual File objects, so a video survives a reload without being
 *         re-picked. Browsers store these on disk, not in memory.
 * marks:  clip in/out points per video, saved on every change.
 */

const DB = 'quiklip';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('marks')) db.createObjectStore('marks', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/** Stable id for a file — same file re-picked gets its marks back. */
export const fileId = (f) => `${f.name}::${f.size}::${f.lastModified}`;

export async function saveVideo(file, meta) {
  const id = fileId(file);
  await tx('videos', 'readwrite', (s) =>
    s.put({ id, name: file.name, size: file.size, lastModified: file.lastModified, addedAt: Date.now(), file, meta })
  );
  return id;
}

export async function listVideos() {
  const rows = await tx('videos', 'readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => b.addedAt - a.addedAt);
}

export async function getVideo(id) {
  return tx('videos', 'readonly', (s) => s.get(id));
}

export async function deleteVideo(id) {
  await tx('videos', 'readwrite', (s) => s.delete(id));
  await tx('marks', 'readwrite', (s) => s.delete(id));
}

export async function saveMarks(id, clips, settings) {
  await tx('marks', 'readwrite', (s) => s.put({ id, clips, settings, updatedAt: Date.now() }));
}

export async function getMarks(id) {
  const row = await tx('marks', 'readonly', (s) => s.get(id));
  return row || { clips: [], settings: null };
}

/** Rough storage picture, so the UI can warn before a quota failure. */
export async function quota() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota: q } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: q || 0 };
  } catch {
    return null;
  }
}
