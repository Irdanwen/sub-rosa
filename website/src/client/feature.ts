/**
 * How the web client's features plug into it (WP20b).
 *
 * The chat of WP19 (`agent.ts`, `ui/WebClient.tsx`) stays the core. A feature
 * (deep research, study, documents, analysis, assignments, connectors,
 * voice, finances, protected mode) is a module under `client/<feature>/`
 * that exports one `WebFeature`, listed once in `features.ts`. It reaches
 * the page only through the `FeatureHost` handed to it: the synchronised
 * objects, a sealed store of its own, the operator and the key, and the
 * page's own turn, so a feature's turn is an ordinary chat turn with the
 * same prompt, memory and history as a typed one.
 *
 * Everything a feature keeps in this browser goes through `FeatureStore`:
 * IndexedDB, sealed under the vault key like the rest of the client's cache
 * (ADR-0101 decision 4).
 */
import type { ComponentType } from "react";
import type { Account } from "../lib/api";
import { decrypt, encrypt } from "../lib/vault";
import type { ChatMessage, LiveModel, Operator } from "./carpe-diem";
import type { ToolDefinition } from "./codec";
import type { ChatModel } from "./models";
import type { ClientStore } from "./store";
import type { SyncClient } from "./sync";

type Key = Uint8Array<ArrayBuffer>;

// ── Protected mode ─────────────────────────────────────────────────────────

/** What protected mode lets through in this browser (ADR-0084, held per
 * browser). The page asks these before a request leaves, never the server. */
export interface Guards {
  on: boolean;
  /** The models a picker may offer. */
  models<T extends { id: string; name?: string }>(models: T[]): T[];
  /** Why a chat turn on this model may not leave now, or null when it may. */
  chatRefusal(model: string): string | null;
  /** Memory, past chats, voice and image or video generation, each allowed? */
  memory: boolean;
  pastChats: boolean;
  voice: boolean;
  media: boolean;
  /** The protective instruction joined to every system prompt, or null. */
  promptBlock: string | null;
}

/** No protected mode: everything passes. */
export const OPEN_GUARDS: Guards = {
  on: false,
  models: (models) => models,
  chatRefusal: () => null,
  memory: true,
  pastChats: true,
  voice: true,
  media: true,
  promptBlock: null,
};

// ── Turns ──────────────────────────────────────────────────────────────────

/** The turn a feature is asked to add to. */
export interface TurnInfo {
  /** The chat, or null for a temporary chat. */
  chatId: string | null;
  temporary: boolean;
  /** The person's last message. */
  question: string;
  signal?: AbortSignal;
  onStatus?: (stage: string, detail?: string) => void;
}

/** What one feature adds to one turn. */
export interface TurnAddition {
  tools: ToolDefinition[];
  /** Words joined after the shared prompt (a mode, a catalog of skills). */
  prompt?: string | null;
  /** Answers a call to one of `tools`; `undefined` hands it to the next. */
  run?(
    name: string,
    args: Record<string, unknown>,
    turn: TurnInfo,
  ): Promise<string | undefined> | string | undefined;
  /** Shapes the messages once, before the first completion (a picture on the
   * question, say). */
  messages?(messages: ChatMessage[]): ChatMessage[];
  /** When not empty, only these tools may be offered this turn (a skill pack
   * picked with `/name`): the turn keeps the intersection, never widens. */
  narrow?: string[];
  /** The finished answer as it is written to the chat (a connector's cards
   * under it, `calls::with_cards`). */
  seal?(answer: string): string;
}

export interface AskOptions {
  /** The chat to continue; absent or null starts a new one. */
  chatId?: string | null;
  /** The new chat's title, when one is started. */
  title?: string;
  /** Additions for this turn beyond the features' own. */
  additions?: TurnAddition[];
  /** Only the tools this answers yes to are offered (an assignment's groups). */
  allowTool?: (name: string) => boolean;
  /** Leave out every feature's own additions (a run that names its tools). */
  bare?: boolean;
  /** Pictures riding the question, as data URLs. */
  images?: string[];
  /** A model for this turn only (a vision model for a picture). */
  model?: string;
  /** Runs beside the page's own turn: nothing streams into the open chat,
   * Stop does not reach it (its `signal` does), and its new chat is not
   * opened. An assignment's run is one. */
  background?: boolean;
  signal?: AbortSignal;
  onText?: (fragment: string) => void;
  onStatus?: (stage: string, detail?: string) => void;
}

export interface AskResult {
  chatId: string;
  answer: string;
  /** Stopped before it finished: `answer` is what was written so far. */
  stopped: boolean;
}

// ── Storage ────────────────────────────────────────────────────────────────

/** A feature's own corner of IndexedDB, sealed under the vault key. */
export interface FeatureStore {
  get<T>(id: string): Promise<T | undefined>;
  put(id: string, value: unknown): Promise<void>;
  delete(id: string): Promise<void>;
  /** Every entry whose id starts with `prefix`, in id order. */
  list<T>(prefix?: string): Promise<{ id: string; value: T }[]>;
}

interface Sealed {
  id: string;
  sealed: string;
}

export function featureStore(
  accountId: string,
  key: Key,
  store: ClientStore,
  feature: string,
): FeatureStore {
  if (!/^[a-z][a-z0-9-]*$/.test(feature)) throw new Error("Invalid feature name");
  const name = (id: string) => `${accountId}:feature:${feature}:${id}`;
  const context = (id: string) => `subrosa:web-feature:v1:${accountId}:${feature}:${id}`;
  const open = async <T>(entry: Sealed | undefined): Promise<T | undefined> =>
    entry ? decrypt<T>(key, entry.sealed, context(entry.id)).catch(() => undefined) : undefined;
  return {
    get: async (id) => open(await store.get<Sealed>("local", name(id))),
    async put(id, value) {
      await store.put("local", name(id), {
        id,
        sealed: await encrypt(key, value, context(id)),
      } satisfies Sealed);
    },
    delete: (id) => store.delete("local", name(id)),
    async list<T>(prefix = "") {
      const out: { id: string; value: T }[] = [];
      for (const entry of await store.list<Sealed>("local", name(prefix))) {
        const value = await open<T>(entry);
        if (value !== undefined) out.push({ id: entry.id, value });
      }
      return out;
    },
  };
}

// ── The host and the feature ───────────────────────────────────────────────

export interface FeatureHost {
  account: Account;
  /** This browser as a device of the account (ADR-0096); its id is null only
   * in tests and while the service has not admitted it. */
  device: { id: string | null; name: string };
  sync: SyncClient;
  /** The vault key, in this tab's memory only: what seals a gallery file's
   * chunks (ADR-0090). Never stored, never sent. */
  vaultKey: Key;
  /** The feature's sealed store. */
  storeFor(feature: string): FeatureStore;
  operator: Operator;
  /** The browser's `cdm_` key, opened for one use, or null. */
  openKey(): Promise<string | null>;
  /** The chat model the person picked, and every model the picker offers. */
  model: string;
  models: ChatModel[];
  /** Carpe Diem's live catalog (speech voices, vision, prices), maybe empty. */
  live: LiveModel[];
  guards: Guards;
  /** Replaces the guards (protected mode does, at start and on every tick). */
  setGuards(guards: Guards): void;
  /** Memory switched on by the person and allowed by the guards. */
  memory: boolean;
  /** The chat on screen, or null. */
  openChatId: string | null;
  /** A turn is running in the page. */
  busy: boolean;
  /** One ordinary chat turn: the question is written to the chat (a new one
   * unless `chatId`), the answer streamed and written, every feature's tools
   * offered unless `bare`. Rejects only when the turn could not run at all. */
  ask(question: string, options?: AskOptions): Promise<AskResult>;
  /** Stops the running turn, keeping what it wrote. */
  stop(): void;
  openChat(id: string): void;
  /** Shows a feature's panel in the main area, or the chat when null. */
  openPanel(id: string | null): void;
  /** A short sentence in the page's status line. */
  notify(text: string): void;
  /** Draws the page again after a feature's own state changed. */
  refresh(): void;
}

export interface ComposerControlProps {
  host: FeatureHost;
  /** The chat in the composer, or null for a new or temporary one. */
  chatId: string | null;
  temporary: boolean;
  draft: string;
  setDraft(draft: string): void;
}

export interface BlockProps {
  payload: Record<string, unknown>;
  host: FeatureHost;
  /** The message the block is in. */
  messageId: string;
}

export interface WebFeature {
  id: string;
  /** The sidebar's entry for the panel; absent when there is no panel. */
  label?(): string;
  Panel?: ComponentType<{ host: FeatureHost }>;
  /** A control beside the composer. */
  ComposerControl?: ComponentType<ComposerControlProps>;
  /** The chat block kinds (`subrosa:<kind>`) this feature draws. */
  blocks?: Record<string, ComponentType<BlockProps>>;
  /** Runs once, before the chat opens (protected mode sets its guards here). */
  start?(host: FeatureHost): Promise<void>;
  /** What the feature adds to a chat turn, or null. */
  turn?(host: FeatureHost, turn: TurnInfo): TurnAddition | null | Promise<TurnAddition | null>;
  /** Every minute while the page is open: an agent runs only while an app is
   * open, and a tab on `/app` is one (ADR-0091). */
  tick?(host: FeatureHost, signal: AbortSignal): Promise<void>;
}
