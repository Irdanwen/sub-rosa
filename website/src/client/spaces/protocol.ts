/**
 * The spaces protocol, version 1, in the browser: the same rules as
 * `src-tauri/src/account/spaces/protocol.rs`, written with WebCrypto only
 * (Ed25519, X25519, HMAC, SHA-256, AES-GCM). The shared vectors in
 * `src-tauri/tests/fixtures/spaces-v1.json` hold the two together, and
 * `docs/security/spaces-protocol.md` is the specification both follow.
 */
import { decode, encode } from "../../lib/vault";

export type Bytes = Uint8Array<ArrayBuffer>;
const text = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

export const MAX_MEMBERS = 50;
export const KINDS = ["project", "note", "file", "conversation", "message", "profile"] as const;
export type Kind = (typeof KINDS)[number];
export const ROLE_OWNER = "owner";
export const ROLE_MEMBER = "member";
export const INVITATION_PREFIX = "srspace1";
const SAFETY_ITERATIONS = 1024;

export class SpaceProtocolError extends Error {
  constructor(public code: "space_invalid" | "space_rollback" | "space_invitation_invalid") {
    super(code);
  }
}
const invalid = () => new SpaceProtocolError("space_invalid");
const rollback = () => new SpaceProtocolError("space_rollback");
const invitationInvalid = () => new SpaceProtocolError("space_invitation_invalid");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
export function b64(bytes: Uint8Array): string {
  return encode(bytes);
}
export function unb64(value: unknown): Bytes {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  try {
    return decode(value);
  } catch {
    throw invalid();
  }
}
function key32(value: unknown): Bytes {
  const bytes = unb64(value);
  if (bytes.length !== 32) throw invalid();
  return bytes;
}
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function u16(value: number): Bytes {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/** A labelled, length-prefixed transcript (u32 big-endian length, UTF-8). */
export class Transcript {
  private parts: Uint8Array[] = [];
  constructor(label: string) {
    this.push(label);
  }
  push(field: string): this {
    const bytes = text.encode(field);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length);
    this.parts.push(length, bytes);
    return this;
  }
  bytes(): Bytes {
    return concat(...this.parts);
  }
}

// --- Hashes, HKDF ------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Bytes));
}
/** HMAC-SHA256. An empty key is HMAC's own zero padding, which WebCrypto
 * refuses to import as such, so it is passed as zeros. */
export async function hmac(key: Uint8Array, message: Uint8Array): Promise<Bytes> {
  const raw = key.length === 0 ? new Uint8Array(32) : (key as Bytes);
  const imported = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, message as Bytes));
}
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Bytes> {
  return hmac(salt, ikm);
}
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number) {
  const out: number[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1; out.length < length; counter++) {
    previous = await hmac(prk, concat(previous, info, new Uint8Array([counter])));
    out.push(...previous.slice(0, Math.min(32, length - out.length)));
  }
  return new Uint8Array(out);
}
export async function hkdf32(ikm: Uint8Array, info: string): Promise<Bytes> {
  return hkdfExpand(await hkdfExtract(new Uint8Array(0), ikm), text.encode(info), 32);
}

// --- X25519, Ed25519 ---------------------------------------------------------

const X25519_PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];
const ED25519_PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

async function x25519Private(secret: Uint8Array) {
  return crypto.subtle.importKey(
    "pkcs8",
    concat(new Uint8Array(X25519_PKCS8), secret),
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
}
export async function x25519Public(secret: Uint8Array): Promise<Bytes> {
  const jwk = await crypto.subtle.exportKey("jwk", await x25519Private(secret));
  return unb64(jwk.x);
}
async function x25519(secret: Uint8Array, publicKey: Uint8Array): Promise<Bytes> {
  const peer = await crypto.subtle.importKey(
    "raw",
    publicKey as Bytes,
    { name: "X25519" },
    true,
    [],
  );
  let shared: Bytes;
  try {
    shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "X25519", public: peer } as unknown as AlgorithmIdentifier,
        await x25519Private(secret),
        256,
      ),
    );
  } catch {
    throw invalid();
  }
  // RFC 9180 7.1.4: a low-order peer key gives the all-zero output.
  if (shared.every((byte) => byte === 0)) throw invalid();
  return shared;
}
async function ed25519Private(seed: Uint8Array) {
  return crypto.subtle.importKey(
    "pkcs8",
    concat(new Uint8Array(ED25519_PKCS8), seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
}
async function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: string) {
  const sig = unb64(signature);
  if (sig.length !== 64) throw invalid();
  const key = await crypto.subtle.importKey("raw", publicKey as Bytes, { name: "Ed25519" }, false, [
    "verify",
  ]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message as Bytes)))
    throw invalid();
}

// --- HPKE (RFC 9180 base mode, X25519 / HKDF-SHA256 / AES-256-GCM) -----------

const KEM_SUITE = concat(text.encode("KEM"), u16(0x0020));
const HPKE_SUITE = concat(text.encode("HPKE"), u16(0x0020), u16(0x0001), u16(0x0002));
const HPKE_V1 = text.encode("HPKE-v1");
async function labeledExtract(suite: Bytes, salt: Uint8Array, label: string, ikm: Uint8Array) {
  return hkdfExtract(salt, concat(HPKE_V1, suite, text.encode(label), ikm));
}
async function labeledExpand(
  suite: Bytes,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) {
  return hkdfExpand(prk, concat(u16(length), HPKE_V1, suite, text.encode(label), info), length);
}
async function sharedSecret(dh: Bytes, enc: Uint8Array, recipient: Uint8Array) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", concat(enc, recipient), 32);
}
async function keySchedule(shared: Bytes, info: Uint8Array) {
  const pskIdHash = await labeledExtract(
    HPKE_SUITE,
    new Uint8Array(0),
    "psk_id_hash",
    new Uint8Array(0),
  );
  const infoHash = await labeledExtract(HPKE_SUITE, new Uint8Array(0), "info_hash", info);
  const context = concat(new Uint8Array([0]), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, shared, "secret", new Uint8Array(0));
  return {
    key: await labeledExpand(HPKE_SUITE, secret, "key", context, 32),
    nonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}
async function aesGcm(
  mode: "encrypt" | "decrypt",
  key: Bytes,
  nonce: Bytes,
  aad: Uint8Array,
  data: Uint8Array,
) {
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, [mode]);
  const params = { name: "AES-GCM", iv: nonce, additionalData: aad as Bytes, tagLength: 128 };
  try {
    return new Uint8Array(
      mode === "encrypt"
        ? await crypto.subtle.encrypt(params, imported, data as Bytes)
        : await crypto.subtle.decrypt(params, imported, data as Bytes),
    );
  } catch {
    throw invalid();
  }
}
export async function hpkeSealWithEphemeral(
  ephemeral: Uint8Array,
  recipient: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
) {
  const enc = await x25519Public(ephemeral);
  const shared = await sharedSecret(await x25519(ephemeral, recipient), enc, recipient);
  const { key, nonce } = await keySchedule(shared, info);
  return { enc, ct: await aesGcm("encrypt", key, nonce, aad, plaintext) };
}
export async function hpkeOpen(
  secret: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
) {
  const recipient = await x25519Public(secret);
  const shared = await sharedSecret(await x25519(secret, enc), enc, recipient);
  const { key, nonce } = await keySchedule(shared, info);
  return aesGcm("decrypt", key, nonce, aad, ciphertext);
}

// --- Envelopes ---------------------------------------------------------------

/** AES-256-GCM in the account's envelope format. A chosen nonce is for the
 * vectors only. */
export async function sealEnvelope(key: Bytes, aad: string, plaintext: Uint8Array, nonce?: Bytes) {
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await aesGcm("encrypt", key, iv, text.encode(aad), plaintext);
  return JSON.stringify({ v: 1, nonce: b64(iv), ciphertext: b64(ciphertext) });
}
export async function openEnvelope(key: Bytes, aad: string, envelope: string): Promise<Bytes> {
  let parsed: { v?: unknown; nonce?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw invalid();
  }
  if (parsed?.v !== 1 || Object.keys(parsed).length !== 3) throw invalid();
  const nonce = unb64(parsed.nonce);
  if (nonce.length !== 12) throw invalid();
  return aesGcm("decrypt", key, nonce, text.encode(aad), unb64(parsed.ciphertext));
}
function parseJson<T>(bytes: Uint8Array, error: () => Error = invalid): T {
  try {
    return JSON.parse(strict.decode(bytes)) as T;
  } catch {
    throw error();
  }
}

// --- Identity ----------------------------------------------------------------

export interface IdentityBundle {
  v: 1;
  account_id: string;
  x25519: string;
  ed25519: string;
  created_at: string;
  signature: string;
}
function identityTranscript(bundle: Omit<IdentityBundle, "signature">) {
  return new Transcript("subrosa:identity:v1")
    .push(bundle.account_id)
    .push(bundle.x25519)
    .push(bundle.ed25519)
    .push(bundle.created_at);
}
export async function verifyBundle(bundle: IdentityBundle): Promise<void> {
  if (
    bundle?.v !== 1 ||
    !isUuid(bundle.account_id) ||
    typeof bundle.created_at !== "string" ||
    bundle.created_at.length > 64
  )
    throw invalid();
  key32(bundle.x25519);
  await ed25519Verify(key32(bundle.ed25519), identityTranscript(bundle).bytes(), bundle.signature);
}

export class IdentitySecret {
  private constructor(
    private x: Bytes,
    private e: Bytes,
  ) {}
  static fromSeeds(x25519Secret: Bytes, ed25519Seed: Bytes) {
    if (x25519Secret.length !== 32 || ed25519Seed.length !== 32) throw invalid();
    return new IdentitySecret(x25519Secret, ed25519Seed);
  }
  static generate() {
    return new IdentitySecret(
      crypto.getRandomValues(new Uint8Array(32)),
      crypto.getRandomValues(new Uint8Array(32)),
    );
  }
  x25519Secret(): Bytes {
    return this.x;
  }
  x25519Public() {
    return x25519Public(this.x);
  }
  async ed25519Public(): Promise<Bytes> {
    const jwk = await crypto.subtle.exportKey("jwk", await ed25519Private(this.e));
    return unb64(jwk.x);
  }
  async sign(message: Uint8Array): Promise<string> {
    return b64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          await ed25519Private(this.e),
          message as Bytes,
        ),
      ),
    );
  }
  async bundle(accountId: string, createdAt: string): Promise<IdentityBundle> {
    const unsigned = {
      v: 1 as const,
      account_id: accountId,
      x25519: b64(await this.x25519Public()),
      ed25519: b64(await this.ed25519Public()),
      created_at: createdAt,
    };
    return { ...unsigned, signature: await this.sign(identityTranscript(unsigned).bytes()) };
  }
  private body(): string {
    return JSON.stringify({ v: 1, x25519_secret: b64(this.x), ed25519_seed: b64(this.e) });
  }
  seal(vaultKey: Bytes, accountId: string, nonce?: Bytes) {
    return sealEnvelope(
      vaultKey,
      `subrosa:identity:v1:${accountId}`,
      text.encode(this.body()),
      nonce,
    );
  }
  static async open(vaultKey: Bytes, accountId: string, envelope: string) {
    const body = parseJson<{ v: number; x25519_secret: string; ed25519_seed: string }>(
      await openEnvelope(vaultKey, `subrosa:identity:v1:${accountId}`, envelope),
    );
    if (body.v !== 1 || Object.keys(body).length !== 3) throw invalid();
    return IdentitySecret.fromSeeds(key32(body.x25519_secret), key32(body.ed25519_seed));
  }
}

/** Thirty digits naming one identity. */
export async function fingerprintDigits(bundle: IdentityBundle): Promise<string> {
  let digest = await sha256(
    new Transcript("subrosa:safety:v1")
      .push(bundle.account_id)
      .push(bundle.ed25519)
      .push(bundle.x25519)
      .bytes(),
  );
  for (let i = 0; i < SAFETY_ITERATIONS; i++) digest = await sha256(digest);
  let digits = "";
  for (let chunk = 0; chunk < 6; chunk++) {
    let value = 0n;
    for (const byte of digest.slice(chunk * 5, chunk * 5 + 5)) value = (value << 8n) | BigInt(byte);
    digits += (value % 100000n).toString().padStart(5, "0");
  }
  return digits;
}
export async function safetyNumber(a: IdentityBundle, b: IdentityBundle): Promise<string> {
  const [first, second] = [await fingerprintDigits(a), await fingerprintDigits(b)].sort();
  return first + second;
}
export function grouped(number: string): string[] {
  return number.match(/.{1,5}/g) ?? [];
}

// --- Epoch heads -------------------------------------------------------------

export interface HeadMember {
  account_id: string;
  role: string;
  x25519: string;
  ed25519: string;
}
export interface Departure {
  account_id: string;
  signature: string;
}
export interface EpochHead {
  v: 1;
  space_id: string;
  epoch: number;
  prev: string;
  owner: string;
  members: HeadMember[];
  key_commitment: string;
  author: string;
  departures: Departure[];
  created_at: string;
  signature: string;
}
export function memberFromBundle(bundle: IdentityBundle, role: string): HeadMember {
  return { account_id: bundle.account_id, role, x25519: bundle.x25519, ed25519: bundle.ed25519 };
}
function headTranscript(head: Omit<EpochHead, "signature">) {
  const t = new Transcript("subrosa:space-head:v1")
    .push(head.space_id)
    .push(String(head.epoch))
    .push(head.prev)
    .push(head.owner)
    .push(String(head.members.length));
  for (const m of head.members) t.push(m.account_id).push(m.role).push(m.x25519).push(m.ed25519);
  t.push(head.key_commitment).push(head.author).push(String(head.departures.length));
  for (const d of head.departures) t.push(d.account_id).push(d.signature);
  return t.push(head.created_at);
}
export async function headHash(head: EpochHead): Promise<string> {
  return b64(await sha256(headTranscript(head).push(head.signature).bytes()));
}
export async function keyCommitment(key: Bytes, spaceId: string, epoch: number) {
  return b64(await hmac(key, text.encode(`subrosa:space-key-commit:v1:${spaceId}:${epoch}`)));
}
const byAccount = (a: { account_id: string }, b: { account_id: string }) =>
  a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0;

export async function signHead(
  draft: {
    spaceId: string;
    epoch: number;
    prev: EpochHead | null;
    owner: string;
    members: HeadMember[];
    key: Bytes;
    author: string;
    departures: Departure[];
    createdAt: string;
  },
  identity: IdentitySecret,
): Promise<EpochHead> {
  const unsigned = {
    v: 1 as const,
    space_id: draft.spaceId,
    epoch: draft.epoch,
    prev: draft.prev ? await headHash(draft.prev) : "",
    owner: draft.owner,
    members: [...draft.members].sort(byAccount),
    key_commitment: await keyCommitment(draft.key, draft.spaceId, draft.epoch),
    author: draft.author,
    departures: [...draft.departures].sort(byAccount),
    created_at: draft.createdAt,
  };
  return { ...unsigned, signature: await identity.sign(headTranscript(unsigned).bytes()) };
}
function leaveTranscript(spaceId: string, epoch: number, accountId: string) {
  return new Transcript("subrosa:space-leave:v1").push(spaceId).push(String(epoch)).push(accountId);
}
export function leaveStatement(
  identity: IdentitySecret,
  spaceId: string,
  epoch: number,
  accountId: string,
) {
  return identity.sign(leaveTranscript(spaceId, epoch, accountId).bytes());
}
export function headMember(head: EpochHead, accountId: string) {
  return head.members.find((m) => m.account_id === accountId);
}
function sameMember(a: HeadMember, b: HeadMember) {
  return (
    a.account_id === b.account_id &&
    a.role === b.role &&
    a.x25519 === b.x25519 &&
    a.ed25519 === b.ed25519
  );
}
function checkShape(head: EpochHead) {
  const sorted = (list: { account_id: string }[]) =>
    list.every((item, i) => i === 0 || list[i - 1].account_id < item.account_id);
  const owners = head.members?.filter((m) => m.role === ROLE_OWNER) ?? [];
  if (
    head?.v !== 1 ||
    !isUuid(head.space_id) ||
    !Number.isSafeInteger(head.epoch) ||
    head.epoch < 1 ||
    !Array.isArray(head.members) ||
    !Array.isArray(head.departures) ||
    !sorted(head.members) ||
    !sorted(head.departures) ||
    head.members.length === 0 ||
    head.members.length > MAX_MEMBERS ||
    owners.length !== 1 ||
    owners[0].account_id !== head.owner ||
    typeof head.created_at !== "string" ||
    head.created_at.length > 64
  )
    throw invalid();
  key32(head.key_commitment);
  for (const m of head.members) {
    if (!isUuid(m.account_id) || (m.role !== ROLE_OWNER && m.role !== ROLE_MEMBER)) throw invalid();
    key32(m.x25519);
    key32(m.ed25519);
  }
}
/** One head against the one before it (`null` for the first epoch). */
export async function verifyNext(prev: EpochHead | null, head: EpochHead): Promise<void> {
  checkShape(head);
  const message = headTranscript(head).bytes();
  if (!prev) {
    const owner = headMember(head, head.owner);
    if (
      !owner ||
      head.epoch !== 1 ||
      head.prev !== "" ||
      head.author !== head.owner ||
      head.departures.length
    )
      throw invalid();
    return ed25519Verify(key32(owner.ed25519), message, head.signature);
  }
  if (
    head.space_id !== prev.space_id ||
    head.epoch !== prev.epoch + 1 ||
    head.prev !== (await headHash(prev)) ||
    head.owner !== prev.owner
  )
    throw invalid();
  const author = headMember(prev, head.author);
  if (!author) throw invalid();
  await ed25519Verify(key32(author.ed25519), message, head.signature);
  for (const departure of head.departures) {
    const leaving = headMember(prev, departure.account_id);
    if (!leaving || departure.account_id === head.owner || headMember(head, departure.account_id))
      throw invalid();
    await ed25519Verify(
      key32(leaving.ed25519),
      leaveTranscript(head.space_id, prev.epoch, departure.account_id).bytes(),
      departure.signature,
    );
  }
  if (head.author === head.owner) return;
  const leaving = new Set(head.departures.map((d) => d.account_id));
  const expected = prev.members.filter((m) => !leaving.has(m.account_id));
  if (
    leaving.size === 0 ||
    leaving.has(head.author) ||
    expected.length !== head.members.length ||
    expected.some((m, i) => !sameMember(m, head.members[i]))
  )
    throw invalid();
}
/** What a chain check leaves a tab to rely on: the latest head, and every
 * head it may use for a key's commitment, a membership or an author's key. */
export interface VerifiedChain {
  latest: EpochHead;
  heads: Map<number, EpochHead>;
}
/** The heads a service returned, against what this tab already trusts. A
 * later head verifies forward from the trusted one; an earlier one must be
 * the head it names, link by link (`hash(head_e) == head_{e+1}.prev`). A
 * returned head below a missing epoch, or one that does not link, is another
 * history: a rollback. Omitted old heads are simply not in `heads`. */
export async function verifyChain(
  trusted: EpochHead | null,
  heads: EpochHead[],
  anchor: IdentityBundle | null,
): Promise<VerifiedChain> {
  const ordered = [...heads].sort((a, b) => a.epoch - b.epoch);
  if (ordered.some((h, i) => i > 0 && ordered[i - 1].epoch === h.epoch)) throw invalid();
  const latest = ordered.at(-1);
  if (!latest) throw invalid();
  const verified = new Map<number, EpochHead>();
  if (trusted) {
    if (latest.epoch < trusted.epoch) throw rollback();
    const same = ordered.find((h) => h.epoch === trusted.epoch);
    if (same && (await headHash(same)) !== (await headHash(trusted))) throw rollback();
    let previous = trusted;
    for (const head of ordered.filter((h) => h.epoch > trusted.epoch)) {
      await verifyNext(previous, head);
      verified.set(head.epoch, head);
      previous = head;
    }
    verified.set(trusted.epoch, trusted);
    let link = trusted;
    for (const head of ordered.filter((h) => h.epoch < trusted.epoch).reverse()) {
      if (head.epoch + 1 !== link.epoch || (await headHash(head)) !== link.prev) throw rollback();
      checkShape(head);
      verified.set(head.epoch, head);
      link = head;
    }
    return { latest, heads: verified };
  }
  await verifyNext(null, ordered[0]);
  if (anchor) {
    const owner = headMember(ordered[0], ordered[0].owner);
    if (
      !owner ||
      owner.account_id !== anchor.account_id ||
      owner.x25519 !== anchor.x25519 ||
      owner.ed25519 !== anchor.ed25519
    )
      throw invalid();
  }
  for (let i = 1; i < ordered.length; i++) await verifyNext(ordered[i - 1], ordered[i]);
  for (const head of ordered) verified.set(head.epoch, head);
  return { latest, heads: verified };
}

// --- Wrapped keys ------------------------------------------------------------

const wrapInfo = (spaceId: string, epoch: number, accountId: string) =>
  text.encode(`subrosa:space-key:v1:${spaceId}:${epoch}:${accountId}`);
export async function wrapKey(
  key: Bytes,
  recipientX25519: string,
  spaceId: string,
  epoch: number,
  accountId: string,
  ephemeral: Bytes = crypto.getRandomValues(new Uint8Array(32)),
) {
  const { enc, ct } = await hpkeSealWithEphemeral(
    ephemeral,
    key32(recipientX25519),
    wrapInfo(spaceId, epoch, accountId),
    new Uint8Array(0),
    key,
  );
  return JSON.stringify({ v: 1, enc: b64(enc), ct: b64(ct) });
}
export async function unwrapKey(
  identity: IdentitySecret,
  sealed: string,
  head: EpochHead,
  accountId: string,
): Promise<Bytes> {
  let parsed: { v?: unknown; enc?: unknown; ct?: unknown };
  try {
    parsed = JSON.parse(sealed);
  } catch {
    throw invalid();
  }
  if (parsed?.v !== 1) throw invalid();
  const key = await hpkeOpen(
    identity.x25519Secret(),
    key32(parsed.enc),
    wrapInfo(head.space_id, head.epoch, accountId),
    new Uint8Array(0),
    unb64(parsed.ct),
  );
  if (
    key.length !== 32 ||
    (await keyCommitment(key, head.space_id, head.epoch)) !== head.key_commitment
  )
    throw invalid();
  return key;
}

// --- Objects -----------------------------------------------------------------

export interface ObjectBody {
  v: 1;
  kind: Kind;
  object_id: string;
  revision: string;
  parent_revision: string | null;
  author: string;
  created_at: string;
  deleted: boolean;
  data: Record<string, unknown>;
}
export interface WireObject {
  object_id: string;
  revision: string;
  parent_revision: string | null;
  kind: string;
  epoch: number;
  author_account_id: string;
  ciphertext: string;
  signature: string;
  deleted: boolean;
}
export function objectAad(
  spaceId: string,
  epoch: number,
  kind: string,
  objectId: string,
  revision: string,
  author: string,
) {
  return `subrosa:space-object:v1:${spaceId}:${epoch}:${kind}:${objectId}:${revision}:${author}`;
}
async function objectSignatureTranscript(aad: string, ciphertext: string) {
  return new Transcript("subrosa:space-object-signature:v1")
    .push(aad)
    .push(b64(await sha256(text.encode(ciphertext))))
    .bytes();
}
export function checkData(kind: string, data: unknown, author: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const record = data as Record<string, unknown>;
  const field = (name: string, max: number) => {
    const value = record[name];
    if (typeof value !== "string" || [...value].length > max) throw invalid();
  };
  switch (kind) {
    case "project":
      field("name", 200);
      field("instructions", 8000);
      return;
    case "note":
      field("title", 300);
      field("body", 200_000);
      return;
    case "file":
      field("name", 300);
      field("format", 40);
      field("text", 400_000);
      return;
    case "conversation":
      field("title", 300);
      return;
    case "profile":
      field("name", 80);
      return;
    case "message":
      field("conversation_id", 36);
      field("text", 100_000);
      if (record.role === "user") return;
      if (record.role === "assistant") {
        field("model", 200);
        if (record.paid_by === author) return;
      }
      throw invalid();
    default:
      throw invalid();
  }
}
/** The exact plaintext an object seals: the body's fields in protocol order. */
export function objectPlaintext(body: ObjectBody): string {
  return JSON.stringify({
    v: body.v,
    kind: body.kind,
    object_id: body.object_id,
    revision: body.revision,
    parent_revision: body.parent_revision,
    author: body.author,
    created_at: body.created_at,
    deleted: body.deleted,
    data: body.data,
  });
}
export async function sealObject(
  key: Bytes,
  spaceId: string,
  epoch: number,
  body: ObjectBody,
  identity: IdentitySecret,
  nonce?: Bytes,
  plaintext: string = objectPlaintext(body),
) {
  if (!KINDS.includes(body.kind) || body.v !== 1) throw invalid();
  if (!body.deleted) checkData(body.kind, body.data, body.author);
  const aad = objectAad(spaceId, epoch, body.kind, body.object_id, body.revision, body.author);
  const ciphertext = await sealEnvelope(key, aad, text.encode(plaintext), nonce);
  const signature = await identity.sign(await objectSignatureTranscript(aad, ciphertext));
  return { ciphertext, signature };
}
export async function openObject(
  key: Bytes,
  spaceId: string,
  wire: WireObject,
  author: HeadMember,
): Promise<ObjectBody> {
  if (author.account_id !== wire.author_account_id || !KINDS.includes(wire.kind as Kind))
    throw invalid();
  const aad = objectAad(
    spaceId,
    wire.epoch,
    wire.kind,
    wire.object_id,
    wire.revision,
    wire.author_account_id,
  );
  await ed25519Verify(
    key32(author.ed25519),
    await objectSignatureTranscript(aad, wire.ciphertext),
    wire.signature,
  );
  const body = parseJson<ObjectBody>(await openEnvelope(key, aad, wire.ciphertext));
  if (
    body.v !== 1 ||
    body.kind !== wire.kind ||
    body.object_id !== wire.object_id ||
    body.revision !== wire.revision ||
    (body.parent_revision ?? null) !== (wire.parent_revision ?? null) ||
    body.author !== wire.author_account_id ||
    body.deleted !== wire.deleted
  )
    throw invalid();
  if (!body.deleted) checkData(body.kind, body.data, body.author);
  return body;
}

// --- Invitations -------------------------------------------------------------

export interface InvitePayload {
  v: 1;
  space_id: string;
  space_name: string;
  inviter: IdentityBundle;
  expires_at: string;
}
export function inviteToken(secret: Bytes, invitationId: string) {
  return hkdf32(secret, `subrosa:invite-token:v1:${invitationId}`);
}
export async function tokenHash(token: Bytes) {
  return b64(await sha256(token));
}
/** The exact plaintext a payload seals: its fields, and the inviter's, in
 * protocol order, whatever order a stored bundle came back in (the service
 * keeps it as `jsonb`, which reorders keys). */
export function payloadPlaintext(payload: InvitePayload): string {
  const inviter = payload.inviter;
  return JSON.stringify({
    v: payload.v,
    space_id: payload.space_id,
    space_name: payload.space_name,
    inviter: {
      v: inviter.v,
      account_id: inviter.account_id,
      x25519: inviter.x25519,
      ed25519: inviter.ed25519,
      created_at: inviter.created_at,
      signature: inviter.signature,
    },
    expires_at: payload.expires_at,
  });
}
export async function sealPayload(
  secret: Bytes,
  invitationId: string,
  payload: InvitePayload,
  nonce?: Bytes,
  plaintext: string = payloadPlaintext(payload),
) {
  return sealEnvelope(
    await hkdf32(secret, `subrosa:invite-payload:v1:${invitationId}`),
    `subrosa:invite:v1:${invitationId}`,
    text.encode(plaintext),
    nonce,
  );
}
export async function openPayload(secret: Bytes, invitationId: string, sealed: string) {
  let payload: InvitePayload;
  try {
    payload = parseJson<InvitePayload>(
      await openEnvelope(
        await hkdf32(secret, `subrosa:invite-payload:v1:${invitationId}`),
        `subrosa:invite:v1:${invitationId}`,
        sealed,
      ),
    );
    if (payload.v !== 1 || !isUuid(payload.space_id)) throw invalid();
    await verifyBundle(payload.inviter);
  } catch {
    throw invitationInvalid();
  }
  return payload;
}
export async function acceptanceProof(
  secret: Bytes,
  invitationId: string,
  spaceId: string,
  member: IdentityBundle,
) {
  const key = await hkdf32(secret, `subrosa:invite-accept:v1:${invitationId}`);
  return b64(
    await hmac(
      key,
      new Transcript("subrosa:space-accept:v1")
        .push(invitationId)
        .push(spaceId)
        .push(member.account_id)
        .push(member.x25519)
        .push(member.ed25519)
        .bytes(),
    ),
  );
}
export function invitationCode(invitationId: string, secret: Uint8Array) {
  return `${INVITATION_PREFIX}.${invitationId}.${b64(secret)}`;
}
export function parseInvitation(input: string): { invitationId: string; secret: Bytes } {
  const start = input.indexOf(`${INVITATION_PREFIX}.`);
  if (start < 0) throw invitationInvalid();
  const code = /^[A-Za-z0-9._-]+/.exec(input.slice(start))?.[0] ?? "";
  const [, id, secret] = code.split(".");
  if (!isUuid(id)) throw invitationInvalid();
  try {
    return { invitationId: id, secret: key32(secret) };
  } catch {
    throw invitationInvalid();
  }
}
