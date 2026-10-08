/**
 * Where a connector's access lives in this browser: its tokens, a pending
 * sign-in's verifier, a developer's pasted token. None of it travels (the
 * definitions do, ADR-0092), none of it reaches the sync, and none of it is
 * readable at rest: each value is sealed with AES-GCM under a key WebCrypto
 * generated non-extractable for this browser and keeps in IndexedDB, the way
 * `browser-device.ts` seals the Carpe Diem key. The page can ask that key to
 * open a value; it can never read the key itself.
 *
 * Not the vault key, on purpose: a sign-in leaves the page for the server's
 * authorization page and comes back to a fresh `/app`, where the vault is
 * locked again. The verifier has to be there before the vault opens.
 */
import { decode, encode } from "../../lib/vault";

export interface SecretBackend {
  /** The browser's wrapping key, made on first use. */
  key(): Promise<CryptoKey>;
  get(name: string): Promise<{ iv: string; ciphertext: string } | undefined>;
  put(name: string, value: { iv: string; ciphertext: string }): Promise<void>;
  delete(name: string): Promise<void>;
  /** Every stored name that starts with `prefix`. */
  names(prefix: string): Promise<string[]>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function newKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
}

const DB_NAME = "subrosa-connectors";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const store of ["keys", "secrets"])
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function inStore<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let wrapping: Promise<CryptoKey> | null = null;
export const indexedDbSecrets: SecretBackend = {
  key() {
    wrapping ??= (async () => {
      const known = await inStore<CryptoKey | undefined>("keys", "readonly", (s) => s.get("wrap"));
      if (known) return known;
      const made = await newKey();
      await inStore("keys", "readwrite", (s) => s.put(made, "wrap"));
      return made;
    })().catch((error) => {
      wrapping = null;
      throw error;
    });
    return wrapping;
  },
  get: (name) => inStore("secrets", "readonly", (s) => s.get(name)),
  async put(name, value) {
    await inStore("secrets", "readwrite", (s) => s.put(value, name));
  },
  async delete(name) {
    await inStore("secrets", "readwrite", (s) => s.delete(name));
  },
  names: (prefix) =>
    inStore("secrets", "readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))),
};

/** The same contract in memory, for tests and a browser that refuses
 * IndexedDB (sign-ins then last as long as the tab). */
export function memorySecrets(): SecretBackend {
  const values = new Map<string, { iv: string; ciphertext: string }>();
  let made: Promise<CryptoKey> | null = null;
  return {
    key: () => {
      made ??= newKey();
      return made;
    },
    get: async (name) => values.get(name),
    put: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
    names: async (prefix) => [...values.keys()].filter((name) => name.startsWith(prefix)),
  };
}

/** Sealed values for one account, each bound to its name. */
export class Secrets {
  constructor(
    private readonly accountId: string,
    private readonly backend: SecretBackend,
  ) {}

  private name(slot: string) {
    return `${this.accountId}:${slot}`;
  }
  private context(slot: string) {
    return encoder.encode(`subrosa:connector-secret:v1:${this.accountId}:${slot}`);
  }

  async put(slot: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: this.context(slot), tagLength: 128 },
        await this.backend.key(),
        plaintext,
      );
      await this.backend.put(this.name(slot), {
        iv: encode(iv),
        ciphertext: encode(new Uint8Array(ciphertext)),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async get<T>(slot: string): Promise<T | undefined> {
    const stored = await this.backend.get(this.name(slot)).catch(() => undefined);
    if (!stored) return undefined;
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(stored.iv),
          additionalData: this.context(slot),
          tagLength: 128,
        },
        await this.backend.key(),
        decode(stored.ciphertext),
      );
      return JSON.parse(decoder.decode(plaintext)) as T;
    } catch {
      return undefined;
    }
  }

  /** Reads and forgets: a pending sign-in is single use. */
  async take<T>(slot: string): Promise<T | undefined> {
    const value = await this.get<T>(slot);
    await this.backend.delete(this.name(slot)).catch(() => undefined);
    return value;
  }

  delete(slot: string) {
    return this.backend.delete(this.name(slot)).catch(() => undefined);
  }

  async slots(prefix: string): Promise<string[]> {
    const names = await this.backend.names(this.name(prefix)).catch(() => [] as string[]);
    return names.map((name) => name.slice(this.accountId.length + 1));
  }
}

export const tokensSlot = (connectorId: string) => `tokens:${connectorId}`;
export const pendingSlot = (state: string) => `pending:${state}`;
