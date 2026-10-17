// The workflow ComfyUI writes into what it makes. A picture saved by
// ComfyUI carries its graph in PNG text chunks ("workflow", the editor's
// file, and "prompt", the executable one); WebP pictures and videos carry
// the same JSON in their metadata. This is how people share ComfyUI
// workflows, so dropping such a file opens the same import, with its report
// (ADR-0075). Read with no dependency: the PNG chunks by hand, compressed
// ones through the platform's DecompressionStream, the rest by finding the
// JSON in the metadata bytes.

/** Files larger than this are read only at both ends, where containers keep
 * their metadata. */
const WHOLE_FILE_LIMIT = 8 * 1024 * 1024;
const END_SLICE = 4 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return text;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream === "undefined") return undefined;
  try {
    const body = new Response(new Uint8Array(bytes)).body;
    if (!body) return undefined;
    const stream = body.pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/** The text chunks of a PNG, by keyword. */
export async function pngTextChunks(bytes: Uint8Array): Promise<Map<string, string>> {
  const chunks = new Map<string, string>();
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return chunks;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const split = data.indexOf(0);
      if (split > 0)
        chunks.set(latin1(data.subarray(0, split)), utf8.decode(data.subarray(split + 1)));
    } else if (type === "iTXt") {
      // keyword \0 compressed-flag method \0 language \0 translated \0 text
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0) {
        const compressed = data[keywordEnd + 1] === 1;
        let cursor = keywordEnd + 3;
        cursor = data.indexOf(0, cursor) + 1;
        cursor = data.indexOf(0, cursor) + 1;
        if (cursor > 0) {
          const body = data.subarray(cursor);
          const text = compressed ? await inflate(body) : body;
          if (text) chunks.set(latin1(data.subarray(0, keywordEnd)), utf8.decode(text));
        }
      }
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  return chunks;
}

/** The first JSON object in `text` that parses and looks like a ComfyUI
 * graph (the editor's file has nodes and links; the executable one has
 * class_type entries). */
export function findComfyJson(text: string): string | undefined {
  for (const marker of ['"last_node_id"', '"nodes"', '"class_type"']) {
    let at = text.indexOf(marker);
    while (at >= 0) {
      // Walk back to each opening brace before the marker and try the
      // balanced object from there, nearest first.
      for (let start = text.lastIndexOf("{", at); start >= 0 && at - start < 200_000; ) {
        const candidate = balanced(text, start);
        if (candidate) {
          try {
            const parsed: unknown = JSON.parse(candidate);
            if (looksLikeComfy(parsed)) return candidate;
          } catch {
            // Not this brace; try the one before.
          }
        }
        // lastIndexOf clamps a negative start to 0: stop at the first brace.
        start = start === 0 ? -1 : text.lastIndexOf("{", start - 1);
      }
      at = text.indexOf(marker, at + marker.length);
    }
  }
  return undefined;
}

function looksLikeComfy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.nodes) && (Array.isArray(record.links) || record.links)) return true;
  return Object.values(record).some(
    (entry) => !!entry && typeof entry === "object" && "class_type" in (entry as object),
  );
}

/** The longest graph worth looking for, in characters. */
const MAX_GRAPH_CHARS = 5 * 1024 * 1024;

/** The balanced JSON object starting at `start`, strings respected. */
function balanced(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  const end = Math.min(text.length, start + MAX_GRAPH_CHARS);
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** The ComfyUI workflow a picture or a video carries, as JSON text, or
 * nothing when it carries none. The editor's file is preferred: it keeps
 * positions, notes and groups. */
export async function readEmbeddedWorkflow(file: Blob): Promise<string | undefined> {
  const head = new Uint8Array(
    await file.slice(0, Math.min(file.size, WHOLE_FILE_LIMIT)).arrayBuffer(),
  );
  const chunks = await pngTextChunks(head);
  for (const key of ["workflow", "prompt"]) {
    const text = chunks.get(key);
    if (text && findComfyJson(text)) return text;
  }
  const parts = [latin1(head)];
  if (file.size > WHOLE_FILE_LIMIT) {
    parts.push(latin1(new Uint8Array(await file.slice(file.size - END_SLICE).arrayBuffer())));
  }
  for (const part of parts) {
    // Metadata JSON is UTF-8; read as Latin-1 the braces and quotes are the
    // same bytes, and the found span is decoded properly before parsing.
    const found = findComfyJson(part);
    if (found) {
      const bytes = Uint8Array.from(found, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  }
  return undefined;
}
