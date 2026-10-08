import type { Account } from "../../lib/api";
import type { LiveModel, Operator } from "../carpe-diem";
import type { LocalState } from "../local";
import type { ChatModel } from "../models";
import type { SyncClient } from "../sync";

/** What a view of the web client beyond the chat is given (WP20). */
export interface ClientContext {
  account: Account;
  vaultKey: Uint8Array<ArrayBuffer>;
  sync: SyncClient;
  local: LocalState | null;
  operator: Operator;
  /** The browser's `cdm_` key, opened for one use, or null when it has none. */
  openKey: () => Promise<string | null>;
  models: ChatModel[];
  live: LiveModel[];
  /** The chat model chosen in the header. */
  model: string;
  /** Sends what waits in the outbox. */
  flush: () => void;
  /** Opens a chat in the chat view. */
  openChat: (id: string) => void;
}
