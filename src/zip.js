/**
 * Minimal ZIP writer (STORE method — no compression).
 *
 * Clips are already-compressed H.264, so deflating them would burn CPU for
 * ~0% gain. Storing lets us build the archive with plain byte concatenation
 * and no dependency.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, as ZIP has stored since 1989. */
function dosStamp(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
}

/**
 * @param {{name: string, blob: Blob}[]} files
 * @returns {Promise<Blob>}
 */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp();
  const out = new Writer();
  const central = [];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    if (data.length > 0xffffffff) throw new Error(`${f.name} is too large for a plain zip`);
    const crc = crc32(data);
    const offset = out.len;

    out.u32(0x04034b50);          // local file header
    out.u16(20);                  // version needed
    out.u16(0);                   // flags
    out.u16(0);                   // method: store
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(data.length);         // compressed size
    out.u32(data.length);         // uncompressed size
    out.u16(nameBytes.length);
    out.u16(0);                   // extra length
    out.push(nameBytes);
    out.push(data);

    central.push({ nameBytes, crc, size: data.length, offset });
  }

  const cdStart = out.len;
  for (const c of central) {
    out.u32(0x02014b50);          // central directory header
    out.u16(20);                  // version made by
    out.u16(20);                  // version needed
    out.u16(0);
    out.u16(0);
    out.u16(time);
    out.u16(date);
    out.u32(c.crc);
    out.u32(c.size);
    out.u32(c.size);
    out.u16(c.nameBytes.length);
    out.u16(0);                   // extra
    out.u16(0);                   // comment
    out.u16(0);                   // disk number
    out.u16(0);                   // internal attrs
    out.u32(0);                   // external attrs
    out.u32(c.offset);
    out.push(c.nameBytes);
  }
  const cdSize = out.len - cdStart;

  out.u32(0x06054b50);            // end of central directory
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(cdSize);
  out.u32(cdStart);
  out.u16(0);

  return new Blob(out.parts, { type: 'application/zip' });
}
