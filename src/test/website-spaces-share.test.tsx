// Sharing a project from the web client's panel: behind the preview switch,
// a project of the account becomes a space this account owns, opened at
// once with the project's copy in it.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operator } from "../../website/src/client/carpe-diem";
import {
  addProjectFile,
  createProject,
  saveProjectSettings,
} from "../../website/src/client/projects";
import type { SpacesTransport } from "../../website/src/client/spaces/client";
import type {
  EpochHead,
  IdentityBundle,
  WireObject,
} from "../../website/src/client/spaces/protocol";
import { SpacesEntry } from "../../website/src/client/spaces/SpacesPanel";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { type Account, ApiError } from "../../website/src/lib/api";
import { FakeJournal } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-0000000000a1";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

/** The routes a creation and its first read call, for one account. */
function service() {
  const state = {
    identity: null as { public: IdentityBundle; sealed_private: string } | null,
    spaces: new Map<
      string,
      { head: EpochHead; wrapped: string; objects: (WireObject & { sequence: number })[] }
    >(),
  };
  const missing = () => new ApiError("not_found", "x", 404);
  const transport: SpacesTransport = {
    get: async <T,>(path: string) => {
      if (path === "/api/v1/identity") {
        if (!state.identity) throw missing();
        return structuredClone(state.identity) as T;
      }
      if (path === "/api/v1/spaces")
        return [...state.spaces.keys()].map((id) => ({
          id,
          owner_account_id: ACCOUNT,
          role: "owner",
          current_epoch: 1,
          latest_sequence: 0,
          member_count: 1,
        })) as T;
      const objects = /^\/api\/v1\/spaces\/([^/]+)\/objects\?after=(\d+)/.exec(path);
      if (objects) {
        const page = (state.spaces.get(objects[1])?.objects ?? []).filter(
          (o) => o.sequence > Number(objects[2]),
        );
        return { objects: structuredClone(page), cursor: page.length, has_more: false } as T;
      }
      const detail = /^\/api\/v1\/spaces\/([^/]+)$/.exec(path);
      const space = detail && state.spaces.get(detail[1]);
      if (!space) throw missing();
      return {
        current_epoch: 1,
        members: [{ account_id: ACCOUNT, identity: state.identity?.public }],
        heads: [{ epoch: 1, head: space.head }],
        keys: [{ epoch: 1, sealed: space.wrapped }],
        invitations: [],
        departures: [],
      } as T;
    },
    send: async <T,>(method: string, path: string, body?: unknown) => {
      const b = body as Record<string, unknown>;
      if (path === "/api/v1/identity" && method === "PUT") {
        state.identity = {
          public: b.public as IdentityBundle,
          sealed_private: b.sealed_private as string,
        };
        return { version: 1 } as T;
      }
      if (path === "/api/v1/spaces" && method === "POST") {
        const head = b.head as EpochHead;
        state.spaces.set(head.space_id, {
          head,
          wrapped: b.wrapped_key as string,
          objects: [],
        });
        return { id: head.space_id } as T;
      }
      const objects = /^\/api\/v1\/spaces\/([^/]+)\/objects$/.exec(path);
      const space = objects && state.spaces.get(objects[1]);
      if (!space) throw missing();
      const results = (b.objects as WireObject[]).map((o) => {
        const sequence = space.objects.length + 1;
        space.objects.push({ ...o, author_account_id: ACCOUNT, sequence });
        return { revision: o.revision, sequence };
      });
      return { results } as T;
    },
  };
  return { state, transport };
}

describe("sharing a project from the web client", () => {
  it("offers the account's projects behind the preview, and opens the new space", async () => {
    const sync = new SyncClient(
      ACCOUNT,
      new Uint8Array(32).fill(9),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    const project = await createProject(sync, "Garden");
    await saveProjectSettings(sync, project, {
      instructions: "Answer as a gardener.",
      memoryMode: "project",
    });
    await addProjectFile(sync, project, { name: "plan.md", format: "md", text: "Tomatoes south." });
    const { state, transport } = service();
    const store = memoryClientStore();
    await store.put("local", "spaces-enabled", true);
    render(
      <SpacesEntry
        account={{ id: ACCOUNT, email: "a@example.test", created_at: "" } as Account}
        vaultKey={new Uint8Array(32).fill(7)}
        openKey={async () => null}
        operator={{} as Operator}
        model="model-x"
        transport={transport}
        store={store}
        sync={sync}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Shared projects/ }));
    const choice = await screen.findByRole("combobox", { name: /Share a project/ });
    await userEvent.selectOptions(choice, project);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    // The room of the new space, its name read back from what was written.
    await screen.findByRole("button", { name: "Back" });
    expect(screen.getByText("Garden", { selector: "strong" })).toBeTruthy();
    const [space] = [...state.spaces.values()];
    expect(space.head).toMatchObject({ epoch: 1, owner: ACCOUNT, author: ACCOUNT });
    expect(space.objects.map((o) => o.kind)).toEqual(["project", "file"]);
  });
});
