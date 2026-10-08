/**
 * Just enough of ZIP to read an Office file in the browser: the central
 * directory, stored and deflated entries, nothing else. Inflating is the
 * browser's own (`DecompressionStream("deflate-raw")`), so no library is
 * shipped for it. The guards are the app's (`assistants/references.rs`): at
 * most 4096 entries, and at most 4 MiB of the selected entries, inflated.
 */

export const MAX_ENTRIES = 4096;
export const MAX_SELECTED_BYTES = 4 * 1024 * 1024;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The entries of the central directory. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const data = view(bytes);
  // The end of central directory record is in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--)
    if (data.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new ZipError("Not a zip file.");
  const count = data.getUint16(end + 10, true);
  if (count > MAX_ENTRIES) throw new ZipError("Too many entries.");
  let at = data.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || data.getUint32(at, true) !== 0x02014b50)
      throw new ZipError("Damaged zip directory.");
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    entries.push({
      method: data.getUint16(at + 10, true),
      compressedSize: data.getUint32(at + 20, true),
      size: data.getUint32(at + 24, true),
      offset: data.getUint32(at + 42, true),
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(compressed: Uint8Array, limit: number): Promise<Uint8Array> {
  const body = new Response(compressed as Uint8Array<ArrayBuffer>).body;
  if (!body) throw new ZipError("Empty zip entry.");
  const stream = body.pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ZipError("The document is too large to read.");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Reads the entries `select` keeps, as text, within the shared budget. The
 * declared sizes are not trusted: inflation stops at the budget whatever the
 * header says.
 */
export async function readZipText(
  bytes: Uint8Array,
  select: (name: string) => boolean,
): Promise<Map<string, string>> {
  const data = view(bytes);
  const out = new Map<string, string>();
  let budget = MAX_SELECTED_BYTES;
  const decoder = new TextDecoder();
  for (const entry of zipEntries(bytes)) {
    if (!select(entry.name)) continue;
    const local = entry.offset;
    if (local + 30 > bytes.length || data.getUint32(local, true) !== 0x04034b50)
      throw new ZipError("Damaged zip entry.");
    const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + entry.compressedSize);
    let content: Uint8Array;
    if (entry.method === 0) {
      if (raw.byteLength > budget) throw new ZipError("The document is too large to read.");
      content = raw;
    } else if (entry.method === 8) content = await inflate(raw, budget);
    else throw new ZipError("Unsupported zip compression.");
    budget -= content.byteLength;
    out.set(entry.name, decoder.decode(content));
  }
  return out;
}
