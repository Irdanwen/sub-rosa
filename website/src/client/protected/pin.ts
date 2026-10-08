/**
 * The protected mode PIN in a browser (ADR-0084 decision 1).
 *
 * The app hashes it with scrypt; WebCrypto has no scrypt, so the browser
 * derives it with PBKDF2-SHA256 instead, salted and slow on purpose. The
 * record never leaves this browser, so the two never need to agree. As in the
 * app, four to six digits cannot resist an offline guess by someone who can
 * read the record: the hash only keeps it from being read at a glance, and
 * the record itself is sealed under the vault key with the rest of the
 * client's cache.
 */
import { PROTECTED } from "./rules";

export interface PinHash {
  algorithm: "pbkdf2-sha256";
  iterations: number;
  /** Base64. */
  salt: string;
  hash: string;
}

export const PIN_ITERATIONS = 600_000;
const HASH_BITS = 256;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Four to six ASCII digits, nothing else. */
export function validPin(pin: string): boolean {
  return (
    pin.length >= PROTECTED.pin.minDigits &&
    pin.length <= PROTECTED.pin.maxDigits &&
    /^[0-9]+$/.test(pin)
  );
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      HASH_BITS,
    ),
  );
}

export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    algorithm: "pbkdf2-sha256",
    iterations,
    salt: base64(salt),
    hash: base64(await derive(pin, salt, iterations)),
  };
}

/** Compares every byte, whatever the first difference. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

/** Whether `pin` made `stored`. A damaged record, or one asking for absurd
 * work, matches nothing. */
export async function pinMatches(pin: string, stored: PinHash | undefined): Promise<boolean> {
  if (stored?.algorithm !== "pbkdf2-sha256") return false;
  if (!Number.isInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > 5e6)
    return false;
  try {
    const expected = bytes(stored.hash);
    if (expected.length !== HASH_BITS / 8) return false;
    return sameBytes(await derive(pin, bytes(stored.salt), stored.iterations), expected);
  } catch {
    return false;
  }
}

/** Wrong guesses in a row and until when the next one is refused. In the
 * page only, like the app's process: a reload clears it. */
export class Throttle {
  private failures = 0;
  private lockedUntil: number | null = null;

  /** Whether a try may be made at `now`. */
  allowed(now = Date.now()): boolean {
    if (this.lockedUntil === null) return true;
    if (now < this.lockedUntil) return false;
    this.lockedUntil = null;
    this.failures = 0;
    return true;
  }

  record(ok: boolean, now = Date.now()) {
    if (ok) {
      this.failures = 0;
      this.lockedUntil = null;
      return;
    }
    this.failures += 1;
    if (this.failures >= PROTECTED.pin.maxFailures)
      this.lockedUntil = now + PROTECTED.pin.lockoutSeconds * 1000;
  }
}
