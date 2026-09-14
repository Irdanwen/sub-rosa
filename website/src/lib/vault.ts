import { api, type Change, type VaultRecord } from "./api";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export interface CipherEnvelope {
  v: 1;
  nonce: string;
  ciphertext: string;
}
export interface ProtectedObject {
  v: 1;
  operation_id: string;
  parent_revision: string | null;
  resolved_revisions?: string[];
  deleted: boolean;
  table: string;
  row: Record<string, unknown>;
}
export function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_000_000)
    throw new Error("Invalid encoded data");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (x) =>
    x.charCodeAt(0),
  );
}
function newKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}
async function importKey(key: Uint8Array<ArrayBuffer>) {
  if (key.byteLength !== 32) throw new Error("Invalid key length");
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(
  key: Uint8Array<ArrayBuffer>,
  value: unknown,
  context: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context), tagLength: 128 },
      await importKey(key),
      plaintext,
    );
    return JSON.stringify({
      v: 1,
      nonce: encode(nonce),
      ciphertext: encode(new Uint8Array(ciphertext)),
    } satisfies CipherEnvelope);
  } finally {
    plaintext.fill(0);
  }
}
export async function decrypt<T>(
  key: Uint8Array<ArrayBuffer>,
  value: string,
  context: string,
): Promise<T> {
  const envelope = JSON.parse(value) as CipherEnvelope;
  if (
    envelope.v !== 1 ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("Invalid encrypted envelope");
  const nonce = decode(envelope.nonce);
  if (nonce.length !== 12) throw new Error("Invalid nonce");
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context), tagLength: 128 },
      await importKey(key),
      decode(envelope.ciphertext),
    ),
  );
  try {
    return JSON.parse(decoder.decode(plaintext)) as T;
  } finally {
    plaintext.fill(0);
  }
}
export async function prepareVault(accountId: string) {
  const key = newKey();
  const recovery = newKey();
  const envelope = await encrypt(
    recovery,
    { v: 1, key: encode(key) },
    `subrosa:vault:v1:${accountId}`,
  );
  const recoveryCode = encode(recovery);
  recovery.fill(0);
  return { key, recoveryCode, envelope };
}
export async function unlockVault(accountId: string, recoveryCode: string, record: VaultRecord) {
  const recovery = decode(recoveryCode.trim());
  try {
    const result = await decrypt<{ v: number; key: string }>(
      recovery,
      record.envelope,
      `subrosa:vault:v1:${accountId}`,
    );
    if (result.v !== 1) throw new Error("Unsupported vault version");
    const key = decode(result.key);
    if (key.length !== 32) throw new Error("Invalid vault key");
    return key;
  } finally {
    recovery.fill(0);
  }
}
export async function decryptObject(
  key: Uint8Array<ArrayBuffer>,
  accountId: string,
  change: Change,
) {
  const value = await decrypt<ProtectedObject>(
    key,
    change.ciphertext,
    `subrosa:object:v1:${accountId}:${change.kind}:${change.object_id}`,
  );
  if (
    value.v !== 1 ||
    value.operation_id !== change.operation_id ||
    value.parent_revision !== change.parent_revision ||
    JSON.stringify(value.resolved_revisions ?? []) !==
      JSON.stringify(change.resolved_revisions ?? []) ||
    value.deleted !== change.deleted ||
    !value.row ||
    typeof value.row !== "object" ||
    Array.isArray(value.row)
  )
    throw new Error("Authenticated metadata mismatch");
  return value;
}
export async function writeObject(
  key: Uint8Array<ArrayBuffer>,
  accountId: string,
  objectId: string,
  kind: string,
  table: string,
  row: Record<string, unknown>,
  parentRevision: string | null,
  resolvedRevisions: string[] = [],
) {
  return sendObject(
    await prepareObject(
      key,
      accountId,
      objectId,
      kind,
      table,
      row,
      parentRevision,
      resolvedRevisions,
    ),
  );
}
export async function prepareObject(
  key: Uint8Array<ArrayBuffer>,
  accountId: string,
  objectId: string,
  kind: string,
  table: string,
  row: Record<string, unknown>,
  parentRevision: string | null,
  resolvedRevisions: string[] = [],
) {
  const operation_id = crypto.randomUUID();
  const ciphertext = await encrypt(
    key,
    {
      v: 1,
      operation_id,
      parent_revision: parentRevision,
      resolved_revisions: resolvedRevisions,
      deleted: false,
      table,
      row,
    } satisfies ProtectedObject,
    `subrosa:object:v1:${accountId}:${kind}:${objectId}`,
  );
  return JSON.stringify({
    operations: [
      {
        operation_id,
        object_id: objectId,
        parent_revision: parentRevision,
        resolved_revisions: resolvedRevisions,
        kind,
        ciphertext,
        deleted: false,
      },
    ],
  });
}
export async function sendObject(body: string, signal?: AbortSignal) {
  const expected = JSON.parse(body).operations.map(
    (operation: { operation_id: string }) => operation.operation_id,
  ) as string[];
  const result = await api<{
    results: { operation_id: string; revision: string; sequence: number; conflict: boolean }[];
  }>("/api/v1/sync", {
    method: "POST",
    body,
    signal,
  });
  if (
    !Array.isArray(result.results) ||
    result.results.length !== expected.length ||
    result.results.some(
      (item, index) =>
        item.operation_id !== expected[index] ||
        typeof item.revision !== "string" ||
        typeof item.conflict !== "boolean",
    )
  )
    throw new Error("Invalid sync acknowledgement");
  return result;
}
