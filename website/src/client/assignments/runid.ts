/**
 * `store::run_id`: a run's id is a name-based UUID (v5, OID namespace) of its
 * assignment and its slot, so two devices that both ran one slot wrote one
 * object rather than two results that both look genuine.
 */
const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

function bytesOf(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export async function uuidV5(namespace: string, name: string): Promise<string> {
  const data = new Uint8Array([...bytesOf(namespace), ...new TextEncoder().encode(name)]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function runId(assignmentId: string, slot: string): Promise<string> {
  return uuidV5(NAMESPACE_OID, `subrosa:assignment-run:${assignmentId}:${slot}`);
}
