/**
 * The web client's local cache, in IndexedDB.
 *
 * What it holds is ciphertext or this browser's own conveniences:
 *
 * - `changes`: synchronised revisions exactly as the service sent them,
 *   still encrypted under the vault key, so a reload does not download the
 *   journal again and nothing readable sits on disk;
 * - `outbox`: writes not yet acknowledged, their body sealed under the vault
 *   key with a local context until the moment they are sent;
 * - `meta`: per-kind cursors;
 * - `local`: what never leaves this browser (ratings, which memories a reply
 *   used, personalization), sealed the same way when it says anything about
 *   the person.
 *
 * Opening any of it needs the vault key, which lives only in the tab's memory.
 */
export type Area = "changes" | "outbox" | "meta" | "local";
const AREAS: Area[] = ["changes", "outbox", "meta", "local"];

export interface ClientStore {
  get<T>(area: Area, key: string): Promise<T | undefined>;
  put(area: Area, key: string, value: unknown): Promise<void>;
  delete(area: Area, key: string): Promise<void>;
  /** Every value whose key starts with `prefix`, in key order. */
  list<T>(area: Area, prefix: string): Promise<T[]>;
}

const DB_NAME = "subrosa-web-client";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const area of AREAS)
        if (!request.result.objectStoreNames.contains(area)) request.result.createObjectStore(area);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let shared: Promise<IDBDatabase> | null = null;
function database() {
  shared ??= openDb().catch((error) => {
    shared = null;
    throw error;
  });
  return shared;
}

async function run<T>(
  area: Area,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(area, mode);
    const request = action(tx.objectStore(area));
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const indexedDbClientStore: ClientStore = {
  get: (area, key) => run(area, "readonly", (store) => store.get(key)),
  async put(area, key, value) {
    await run(area, "readwrite", (store) => store.put(value, key));
  },
  async delete(area, key) {
    await run(area, "readwrite", (store) => store.delete(key));
  },
  list: (area, prefix) =>
    run(area, "readonly", (store) =>
      store.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`, false, false)),
    ),
};

/** The same contract in memory: tests, and a browser that refuses storage
 * (the client still works for the session, it only forgets on reload). */
export function memoryClientStore(): ClientStore & { areas: Map<Area, Map<string, unknown>> } {
  const areas = new Map<Area, Map<string, unknown>>(AREAS.map((area) => [area, new Map()]));
  const of = (area: Area) => areas.get(area) as Map<string, unknown>;
  return {
    areas,
    get: async <T>(area: Area, key: string) => structuredClone(of(area).get(key)) as T | undefined,
    put: async (area, key, value) => {
      of(area).set(key, structuredClone(value));
    },
    delete: async (area, key) => {
      of(area).delete(key);
    },
    list: async <T>(area: Area, prefix: string) =>
      [...of(area).entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, value]) => structuredClone(value) as T),
  };
}

/** IndexedDB when it opens, memory otherwise. */
export async function availableClientStore(): Promise<ClientStore> {
  try {
    await database();
    return indexedDbClientStore;
  } catch {
    return memoryClientStore();
  }
}
