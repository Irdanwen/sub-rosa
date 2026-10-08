/**
 * What stays in this browser and never travels: ratings of replies, which
 * memories a reply was given, personalization, the chosen model and effort.
 *
 * Personalization and memory sources say things about the person, so they are
 * sealed under the vault key like everything else on disk here. A rating is a
 * thumb on a message id; the chosen model is a model id.
 *
 * Personalization stays local because the app keeps it local too: it lives in
 * a settings file on each device, and the account has no codec for it
 * (`src-tauri/src/personalization/mod.rs`). The page says so where it is set.
 */
import { decrypt, encrypt } from "../lib/vault";
import { DEFAULT_PERSONALIZATION, type Personalization } from "./agent";
import type { PendingJob } from "./images";
import type { ClientStore } from "./store";

type Key = Uint8Array<ArrayBuffer>;
export type Rating = "up" | "down";
export interface MemorySource {
  id: string;
  text: string;
}
export interface Preferences {
  model?: string;
  effort?: string;
  memory: boolean;
  /** "Reference past chats" (ADR-0081): on by default, with memory. */
  pastChats?: boolean;
}

export class LocalState {
  constructor(
    private readonly accountId: string,
    private readonly key: Key,
    private readonly store: ClientStore,
  ) {}

  private name(kind: string, id = "") {
    return `${this.accountId}:${kind}:${id}`;
  }
  private context(kind: string, id: string) {
    return `subrosa:web-local:v1:${this.accountId}:${kind}:${id}`;
  }
  private async sealed<T>(kind: string, id: string): Promise<T | undefined> {
    const value = await this.store.get<string>("local", this.name(kind, id));
    if (!value) return undefined;
    return decrypt<T>(this.key, value, this.context(kind, id)).catch(() => undefined);
  }
  private async seal(kind: string, id: string, value: unknown) {
    await this.store.put(
      "local",
      this.name(kind, id),
      await encrypt(this.key, value, this.context(kind, id)),
    );
  }

  async personalization(): Promise<Personalization> {
    return {
      ...DEFAULT_PERSONALIZATION,
      ...((await this.sealed<Personalization>("personalization", "")) ?? {}),
    };
  }
  setPersonalization(value: Personalization) {
    return this.seal("personalization", "", value);
  }

  async rating(messageId: string): Promise<Rating | null> {
    const value = await this.store.get<Rating>("local", this.name("rating", messageId));
    return value === "up" || value === "down" ? value : null;
  }
  async setRating(messageId: string, rating: Rating | null) {
    if (rating) await this.store.put("local", this.name("rating", messageId), rating);
    else await this.store.delete("local", this.name("rating", messageId));
  }

  sources(messageId: string): Promise<MemorySource[] | undefined> {
    return this.sealed<MemorySource[]>("sources", messageId);
  }
  setSources(messageId: string, sources: MemorySource[]) {
    return this.seal("sources", messageId, sources);
  }

  /** Picture jobs queued and not yet fetched, so a reload fetches them
   * instead of paying for them again (`images.ts`). */
  async pendingImages(): Promise<PendingJob[]> {
    return (await this.sealed<PendingJob[]>("pending-images", "")) ?? [];
  }
  setPendingImages(jobs: PendingJob[]) {
    return this.seal("pending-images", "", jobs);
  }

  async preferences(): Promise<Preferences> {
    return {
      memory: true,
      ...((await this.store.get<Preferences>("local", this.name("preferences"))) ?? {}),
    };
  }
  setPreferences(value: Preferences) {
    return this.store.put("local", this.name("preferences"), value);
  }
}
