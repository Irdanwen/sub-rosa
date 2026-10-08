/**
 * The zip every Office file is, written in the browser (`../unzip.ts` reads
 * it back). Entries are deflated with the browser's own
 * `CompressionStream("deflate-raw")` when it has one and stored otherwise;
 * readers accept both. No library is shipped.
 */

const encoder = new TextEncoder();

let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function through(stream: CompressionStream, bytes: Uint8Array) {
  const input = new Response(bytes as Uint8Array<ArrayBuffer>).body;
  if (!input) return new Uint8Array(0);
  return new Uint8Array(await new Response(input.pipeThrough(stream)).arrayBuffer());
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day:
      ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

/** A zip of `parts`, in the order given (the content types first, as readers
 * expect). */
export async function writeZip(
  parts: { name: string; bytes: Uint8Array }[],
  now = new Date(),
): Promise<Uint8Array<ArrayBuffer>> {
  const deflate = typeof CompressionStream === "function";
  const { time, day } = dosTime(now);
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = encoder.encode(part.name);
    const data = deflate
      ? await through(new CompressionStream("deflate-raw"), part.bytes)
      : part.bytes;
    const crc = crc32(part.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, part.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, part.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    locals.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...central, end];
  const out = new Uint8Array(all.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of all) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
