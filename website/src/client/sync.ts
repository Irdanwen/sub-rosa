/**
 * The encrypted journal, written from a browser device (ADR-0096).
 *
 * A TypeScript port of the app's revision and conflict rules for the kinds
 * the web client touches (`src-tauri/src/account/sync.rs`): same wire format,
 * same associated data, same authenticated body `{v, operation_id,
 * parent_revision, deleted, resolved_revisions, table, row, …}`. Never a
 * second protocol:
 *
 * - a write names the revision it was made on (`parent_revision`), so a
 *   stale write becomes a sibling on the service, never an overwrite;
 * - a received revision applies only when it descends from what this browser
 *   holds and nothing of the object waits to be sent; anything else is kept
 *   as a conflict, the way the app keeps it for review;
 * - a write is frozen (operation id, parent, ciphertext) before its first
 *   transmission and retried byte for byte, so a lost answer cannot become a
 *   second revision;
 * - a conflict that says exactly what this browser holds is acknowledged, as
 *   the app does, so devices converge without asking anybody.
 *
 * Everything persisted is ciphertext under the vault key: received revisions
 * as they came, and unsent writes sealed with a local context until they are
 * sealed for the service.
 */
import { ApiError, type Change, readChangesFrom } from "../lib/api";
import { decrypt, decryptObject, encrypt, type ProtectedObject, sendObject } from "../lib/vault";
import {
  isKnownTable,
  pulledKinds,
  type Row,
  type SyncKind,
  type TableName,
  tableOf,
  tablesFingerprint,
  validRow,
  WEB_KINDS,
} from "./codec";
import type { ClientStore } from "./store";

type Key = Uint8Array<ArrayBuffer>;

export interface PushResult {
  operation_id: string;
  revision: string;
  sequence: number;
  conflict: boolean;
}
export interface SyncTransport {
  pull(
    kind: SyncKind,
    after: number,
    signal?: AbortSignal,
  ): Promise<{ changes: Change[]; cursor: number }>;
  push(body: string, signal?: AbortSignal): Promise<{ results: PushResult[] }>;
}
/** The account service, through the page's session. */
export const serviceTransport: SyncTransport = {
  pull: (kind, after, signal) => readChangesFrom(after, signal, kind),
  push: (body, signal) => sendObject(body, signal),
};

/** An object as this browser sees it: the last revision it applied, or its
 * own unsent edit over it. */
export interface SyncObject {
  id: string;
  kind: SyncKind;
  table: TableName;
  /** The authenticated body table, kept so a custom assistant's conversation
   * is never rewritten as a plain chat. */
  bodyTable: string;
  row: Row;
  /** Body fields beyond `table` and `row` (a note's summary, an assistant
   * snapshot), carried through an edit untouched. */
  extra: Record<string, unknown>;
  deleted: boolean;
  /** Has an edit this browser has not had acknowledged yet. */
  pending: boolean;
}
export interface Conflict {
  revision: string;
  objectId: string;
  kind: SyncKind;
  table: string;
  row: Row;
  deleted: boolean;
}
interface CachedChange {
  change: Change;
  /** What the rules decided when it arrived, so a reload decides the same. */
  disposition: "applied" | "conflict" | "deferred";
}
interface OutboxEntry {
  sequence: number;
  operationId: string;
  objectId: string;
  kind: SyncKind;
  deleted: boolean;
  resolved: string[];
  /** The body, sealed under a local context while it may still change. */
  local: string;
  /** Set once, before the first transmission; never changed after. */
  sealed?: { parent: string | null; ciphertext: string };
  /** A refusal the service gave that a retry will not change. */
  failed?: string;
}
interface Body {
  table: string;
  row: Row;
  extra: Record<string, unknown>;
}

const ENVELOPE = ["v", "operation_id", "parent_revision", "deleted", "resolved_revisions"];

export class SyncClient {
  readonly objects = new Map<string, SyncObject>();
  readonly conflicts = new Map<string, Conflict[]>();
  private readonly heads = new Map<string, string>();
  private readonly applied = new Map<string, SyncObject>();
  private outbox: OutboxEntry[] = [];
  private nextSequence = 1;
  private listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;
  private readonly prefix: string;

  constructor(
    private readonly accountId: string,
    private readonly key: Key,
    private readonly store: ClientStore,
    private readonly transport: SyncTransport = serviceTransport,
  ) {
    this.prefix = `${accountId}:`;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }

  /** Writes that have not reached the service yet, and the ones it refused. */
  get pendingCount() {
    return this.outbox.filter((entry) => !entry.failed).length;
  }
  get failedCount() {
    return this.outbox.filter((entry) => entry.failed).length;
  }

  // ── Context strings ──────────────────────────────────────────────────────

  private objectContext(kind: string, id: string) {
    return `subrosa:object:v1:${this.accountId}:${kind}:${id}`;
  }
  private localContext(operationId: string) {
    return `subrosa:web-outbox:v1:${this.accountId}:${operationId}`;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Rebuilds the local view from the cache: received revisions in the order
   * they arrived, then this browser's unsent edits over them. */
  async load(): Promise<void> {
    const cached = await this.store.list<CachedChange>("changes", this.prefix);
    cached.sort((a, b) => a.change.sequence - b.change.sequence);
    for (const entry of cached) {
      const body = await this.verify(entry.change).catch(() => null);
      if (!body) continue;
      this.replay(entry, body);
    }
    const queued = await this.store.list<OutboxEntry>("outbox", this.prefix);
    queued.sort((a, b) => a.sequence - b.sequence);
    for (const entry of queued) {
      const body = await decrypt<Body & { deleted?: boolean }>(
        this.key,
        entry.local,
        this.localContext(entry.operationId),
      ).catch(() => null);
      if (!body) continue;
      this.outbox.push(entry);
      this.nextSequence = Math.max(this.nextSequence, entry.sequence + 1);
      this.overlay(entry.objectId, entry.kind, body, entry.deleted);
    }
    this.changed();
  }

  /** Authenticates a received revision the way `sync.rs::verify` does: the
   * AEAD context, the envelope against the service's metadata, a known table
   * of the right kind, a row naming only allowlisted columns, and the row's
   * id equal to the object's. */
  private async verify(change: Change): Promise<Body | null> {
    if (!(WEB_KINDS as readonly string[]).includes(change.kind)) return null;
    const value: ProtectedObject = await decryptObject(this.key, this.accountId, change);
    if ((value.resolved_revisions ?? []).length > 64) throw new Error("Too many resolutions");
    // A table of a pulled kind that this browser does not read (another
    // settings or artifact table): authenticated, then left alone.
    if (typeof value.table !== "string" || !isKnownTable(value.table)) return null;
    const table = tableOf(value.table);
    if (table.kind !== change.kind) throw new Error("Table and kind disagree");
    if (!validRow(value.table, value.row) || value.row.id !== change.object_id)
      throw new Error("Invalid row");
    const extra: Record<string, unknown> = {};
    for (const [field, content] of Object.entries(value))
      if (field !== "table" && field !== "row" && !ENVELOPE.includes(field)) extra[field] = content;
    return { table: value.table, row: value.row as Row, extra };
  }

  /** Pulls every kind from its own cursor and applies what arrived. */
  async pull(signal?: AbortSignal): Promise<void> {
    for (const kind of pulledKinds()) {
      // One cursor per kind and set of tables read: a browser that learns a
      // table reads its kind again from the start (what it already holds is
      // recognised by sequence and skipped) instead of missing what it once
      // passed over unread.
      const cursorKey = `${this.prefix}cursor:${kind}:${tablesFingerprint(kind)}`;
      const after = (await this.store.get<number>("meta", cursorKey)) ?? 0;
      const page = await this.transport.pull(kind, after, signal);
      for (const change of page.changes) {
        if (signal?.aborted) return;
        // Authenticate even this browser's own revisions: a service that
        // substitutes one is refused before anything changes.
        const body = await this.verify(change);
        if (!body) continue;
        const key = `${this.prefix}${change.kind}:${String(change.sequence).padStart(16, "0")}`;
        if (await this.store.get("changes", key)) continue;
        const disposition = this.receive(change, body);
        await this.store.put("changes", key, { change, disposition } satisfies CachedChange);
      }
      await this.store.put("meta", cursorKey, page.cursor);
    }
    await this.acknowledgeIdenticalConflicts();
    this.changed();
  }

  /** The rule of `sync.rs::synchronize` for one received revision. */
  private receive(change: Change, body: Body): CachedChange["disposition"] {
    const id = change.object_id;
    const head = this.heads.get(id);
    if (head === change.revision) return "applied";
    const pending = this.outbox.some((entry) => entry.objectId === id);
    if (
      pending ||
      (head !== undefined &&
        head !== change.parent_revision &&
        !(change.resolved_revisions ?? []).includes(head))
    ) {
      this.preserve(change, body);
      return "conflict";
    }
    if (change.deleted && !this.deletionIsClean(change, body)) {
      this.preserve(change, body);
      return "conflict";
    }
    this.apply(change, body);
    return "applied";
  }

  private replay(entry: CachedChange, body: Body) {
    if (entry.disposition === "conflict") this.preserve(entry.change, body);
    else if (
      entry.disposition === "applied" &&
      this.heads.get(entry.change.object_id) !== entry.change.revision
    )
      this.apply(entry.change, body);
  }

  /** ADR-0072: a deletion applies when nothing of the object's children was
   * revised after it or waits to be sent; a chat's children are its
   * messages. */
  private deletionIsClean(change: Change, body: Body): boolean {
    if (tableOf(body.table).name !== "agent_tasks") return true;
    for (const object of this.objects.values()) {
      if (object.table !== "agent_messages" || object.row.task_id !== change.object_id) continue;
      if (this.outbox.some((entry) => entry.objectId === object.id)) return false;
      const head = this.heads.get(object.id);
      if (head && head > change.revision) return false;
    }
    return true;
  }

  private apply(change: Change, body: Body) {
    const table = tableOf(body.table);
    const row = { ...body.row };
    // A received execution state is history, never a turn to run.
    if (table.name === "agent_tasks") row.status = "completed";
    const object: SyncObject = {
      id: change.object_id,
      kind: change.kind as SyncKind,
      table: table.name,
      bodyTable: body.table,
      row,
      extra: body.extra,
      deleted: change.deleted,
      pending: false,
    };
    this.heads.set(change.object_id, change.revision);
    this.applied.set(change.object_id, object);
    // A head that names earlier conflicts retires them, like `preserve`.
    this.retire(change);
    if (!this.outbox.some((entry) => entry.objectId === change.object_id))
      this.objects.set(change.object_id, object);
    if (change.deleted && table.name === "agent_tasks")
      for (const message of this.objects.values())
        if (message.table === "agent_messages" && message.row.task_id === change.object_id)
          this.objects.set(message.id, { ...message, deleted: true });
  }

  private retire(change: Change) {
    const ancestors = [change.parent_revision, ...(change.resolved_revisions ?? [])];
    const list = this.conflicts.get(change.object_id);
    if (!list) return;
    const kept = list.filter((conflict) => !ancestors.includes(conflict.revision));
    if (kept.length) this.conflicts.set(change.object_id, kept);
    else this.conflicts.delete(change.object_id);
  }

  private preserve(change: Change, body: Body) {
    this.retire(change);
    const list = this.conflicts.get(change.object_id) ?? [];
    if (!list.some((conflict) => conflict.revision === change.revision))
      list.push({
        revision: change.revision,
        objectId: change.object_id,
        kind: change.kind as SyncKind,
        table: body.table,
        row: body.row,
        deleted: change.deleted,
      });
    this.conflicts.set(change.object_id, list);
  }

  private overlay(id: string, kind: SyncKind, body: Body, deleted: boolean) {
    const table = tableOf(body.table);
    this.objects.set(id, {
      id,
      kind,
      table: table.name,
      bodyTable: body.table,
      row: body.row,
      extra: body.extra ?? {},
      deleted,
      pending: true,
    });
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  /**
   * Queues an edit of `row` (its `id` is the object). Like the app's
   * triggers, an edit rewrites the object's last unsent, never-sent write in
   * place instead of queueing another; one that may already be on the
   * service, or a resolution, is never rewritten.
   */
  async write(
    table: TableName,
    row: Row,
    options: { deleted?: boolean; extra?: Record<string, unknown> } = {},
  ): Promise<void> {
    const id = row.id;
    if (typeof id !== "string" || !validRow(table, row)) throw new Error("Invalid row");
    const { kind } = tableOf(table);
    const existing = this.objects.get(id);
    const bodyTable = existing?.bodyTable ?? table;
    const body: Body = { table: bodyTable, row, extra: options.extra ?? existing?.extra ?? {} };
    const deleted = options.deleted ?? false;
    const last = [...this.outbox].reverse().find((entry) => entry.objectId === id);
    let entry: OutboxEntry;
    if (last && !last.sealed && !last.failed && last.resolved.length === 0) {
      entry = { ...last, deleted };
    } else {
      entry = {
        sequence: this.nextSequence++,
        operationId: crypto.randomUUID(),
        objectId: id,
        kind,
        deleted,
        resolved: [],
        local: "",
      };
    }
    entry.local = await encrypt(this.key, body, this.localContext(entry.operationId));
    await this.store.put("outbox", this.outboxKey(entry), entry);
    this.outbox = [...this.outbox.filter((item) => item.operationId !== entry.operationId), entry];
    this.outbox.sort((a, b) => a.sequence - b.sequence);
    this.overlay(id, kind, body, deleted);
    this.changed();
  }

  private outboxKey(entry: OutboxEntry) {
    return `${this.prefix}${String(entry.sequence).padStart(12, "0")}`;
  }

  /** Sends what waits, one object's writes in order. Stops at the first
   * network failure and leaves the rest for the next try: nothing is lost
   * offline, and a retry sends the same bytes. */
  flush(signal?: AbortSignal): Promise<void> {
    this.flushing ??= this.flushOnce(signal).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(signal?: AbortSignal) {
    for (let round = 0; round < 500; round++) {
      const entry = this.outbox.find(
        (item) =>
          !item.failed &&
          !this.outbox.some(
            (earlier) => earlier.objectId === item.objectId && earlier.sequence < item.sequence,
          ),
      );
      if (!entry || signal?.aborted) return;
      const sealed = await this.seal(entry);
      const body = JSON.stringify({
        operations: [
          {
            operation_id: entry.operationId,
            object_id: entry.objectId,
            parent_revision: sealed.parent,
            resolved_revisions: entry.resolved,
            kind: entry.kind,
            ciphertext: sealed.ciphertext,
            deleted: entry.deleted,
          },
        ],
      });
      let result: PushResult;
      try {
        const answer = await this.transport.push(body, signal);
        if (answer.results.length !== 1 || answer.results[0].operation_id !== entry.operationId)
          throw new ApiError("invalid_response", "Invalid sync acknowledgement.", 502);
        result = answer.results[0];
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![401, 408, 409, 429].includes(error.status)
        ) {
          entry.failed = error.code;
          await this.store.put("outbox", this.outboxKey(entry), entry);
          this.changed();
          continue;
        }
        throw error;
      }
      await this.acknowledged(entry, sealed, result);
    }
  }

  private async seal(entry: OutboxEntry): Promise<{ parent: string | null; ciphertext: string }> {
    if (entry.sealed) return entry.sealed;
    const body = await decrypt<Body>(this.key, entry.local, this.localContext(entry.operationId));
    const parent = this.heads.get(entry.objectId) ?? null;
    const ciphertext = await encrypt(
      this.key,
      {
        ...body.extra,
        v: 1,
        operation_id: entry.operationId,
        parent_revision: parent,
        resolved_revisions: entry.resolved,
        deleted: entry.deleted,
        table: body.table,
        row: body.row,
      },
      this.objectContext(entry.kind, entry.objectId),
    );
    entry.sealed = { parent, ciphertext };
    // Durable before the first transmission: a retry after a lost answer
    // sends these exact bytes under this operation id.
    await this.store.put("outbox", this.outboxKey(entry), entry);
    return entry.sealed;
  }

  private async acknowledged(
    entry: OutboxEntry,
    sealed: { parent: string | null; ciphertext: string },
    result: PushResult,
  ) {
    const change: Change = {
      sequence: result.sequence,
      operation_id: entry.operationId,
      object_id: entry.objectId,
      revision: result.revision,
      parent_revision: sealed.parent,
      resolved_revisions: entry.resolved,
      kind: entry.kind,
      ciphertext: sealed.ciphertext,
      deleted: entry.deleted,
      device_id: "",
    };
    const body = await this.verify(change);
    this.outbox = this.outbox.filter((item) => item.operationId !== entry.operationId);
    await this.store.delete("outbox", this.outboxKey(entry));
    // Even a sibling becomes this browser's own head; the other branch comes
    // back on the next pull and is kept as a conflict, never applied over it.
    if (body) {
      this.apply(change, body);
      const key = `${this.prefix}${change.kind}:${String(change.sequence).padStart(16, "0")}`;
      await this.store.put("changes", key, {
        change,
        disposition: "applied",
      } satisfies CachedChange);
    }
    const object = this.objects.get(entry.objectId);
    if (object && this.outbox.some((item) => item.objectId === entry.objectId))
      this.objects.set(entry.objectId, { ...object, pending: true });
    this.changed();
  }

  /** A sibling that says what this browser already holds is not a
   * disagreement: keep the local copy, naming the sibling as resolved, as
   * `sync.rs` does. Deletions and real differences stay for review. */
  private async acknowledgeIdenticalConflicts() {
    for (const [objectId, list] of [...this.conflicts]) {
      const local = this.applied.get(objectId);
      if (!local || this.outbox.some((entry) => entry.objectId === objectId)) continue;
      const head = this.heads.get(objectId);
      for (const conflict of list) {
        if (conflict.deleted || local.deleted) continue;
        if (JSON.stringify(sorted(conflict.row)) !== JSON.stringify(sorted(local.row))) continue;
        if (conflict.table !== local.bodyTable) continue;
        const operationId = crypto.randomUUID();
        const entry: OutboxEntry = {
          sequence: this.nextSequence++,
          operationId,
          objectId,
          kind: local.kind,
          deleted: false,
          resolved: head === conflict.revision ? [] : [conflict.revision],
          local: await encrypt(
            this.key,
            { table: local.bodyTable, row: local.row, extra: local.extra } satisfies Body,
            this.localContext(operationId),
          ),
        };
        await this.store.put("outbox", this.outboxKey(entry), entry);
        this.outbox.push(entry);
        this.conflicts.set(
          objectId,
          (this.conflicts.get(objectId) ?? []).filter((item) => item !== conflict),
        );
        if (!this.conflicts.get(objectId)?.length) this.conflicts.delete(objectId);
        break;
      }
    }
  }

  /** Live objects of one table, as this browser sees them. */
  rows(table: TableName): SyncObject[] {
    return [...this.objects.values()].filter((object) => object.table === table && !object.deleted);
  }
}

function sorted(row: Row): Row {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));
}
