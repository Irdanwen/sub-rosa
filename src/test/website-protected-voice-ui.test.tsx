// The panels of protected mode and voice in the web client, with a fake host:
// turning protected mode on sets the page's guards, and voice says its price
// before the first conversation and refuses while protected mode says so.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FeatureHost,
  featureStore,
  type Guards,
  OPEN_GUARDS,
} from "../../website/src/client/feature";
import { Throttle } from "../../website/src/client/protected/pin";
import { ProtectedPanel } from "../../website/src/client/protected/ProtectedPanel";
import { guardsFor, NO_RESTRICTIONS } from "../../website/src/client/protected/rules";
import { ProtectedMode } from "../../website/src/client/protected/state";
import { memoryClientStore } from "../../website/src/client/store";
import { VoiceControl } from "../../website/src/client/voice/VoiceControl";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function fakeHost(over: Partial<FeatureHost> = {}) {
  const store = memoryClientStore();
  const setGuards = vi.fn<(guards: Guards) => void>();
  const host = {
    storeFor: (feature: string) =>
      featureStore(ACCOUNT, new Uint8Array(32).fill(9), store, feature),
    setGuards,
    guards: OPEN_GUARDS,
    openKey: async () => "cdm_test",
    live: [],
    models: [],
    model: "zai-org-glm-5-2",
    operator: {
      root: "https://operator.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            models: [
              { model: "tts-kokoro", inputPrice: 2 },
              { model: "nvidia/parakeet-tdt-0.6b-v3", inputPrice: 0.006 },
            ],
          }),
          { status: 200 },
        ),
    },
    ...over,
  } as unknown as FeatureHost;
  return { host, setGuards, store };
}

describe("the protected mode panel", () => {
  it("turns protected mode on and puts its guards in force", async () => {
    const user = userEvent.setup();
    const { host, setGuards } = fakeHost();
    const mode = new ProtectedMode(host.storeFor("protected"), new Throttle(), 1000);
    render(<ProtectedPanel host={host} mode={mode} />);
    await user.type(await screen.findByLabelText("Choose a PIN of 4 to 6 digits"), "2468");
    await user.type(screen.getByLabelText("The PIN again"), "2468");
    await user.click(screen.getByRole("button", { name: "Turn on protected mode" }));
    expect(await screen.findByText("Protected mode is on.")).toBeInTheDocument();
    await waitFor(() => expect(setGuards.mock.calls.at(-1)?.[0].on).toBe(true));
    expect((await mode.load()).enabled).toBe(true);
    expect(screen.getByText(/Clearing this browser's data removes it/)).toBeInTheDocument();
  });
});

describe("the voice control", () => {
  it("says the price of a minute before the first conversation", async () => {
    const user = userEvent.setup();
    const { host } = fakeHost();
    render(<VoiceControl host={host} chatId="c" temporary={false} draft="" setDraft={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Voice" }));
    expect(
      await screen.findByText(/A minute of conversation costs about 0.39 credits/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start talking" })).toBeInTheDocument();
  });

  it("refuses to start while protected mode turned voice off", async () => {
    const user = userEvent.setup();
    const { host } = fakeHost({
      guards: guardsFor(true, { ...NO_RESTRICTIONS, voiceOff: true }, 12 * 60),
    });
    render(<VoiceControl host={host} chatId="c" temporary={false} draft="" setDraft={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Voice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Protected mode turned off voice conversations.",
    );
  });

  it("is not offered in a temporary chat", () => {
    const { host } = fakeHost();
    render(<VoiceControl host={host} chatId={null} temporary draft="" setDraft={() => {}} />);
    expect(screen.queryByRole("button", { name: "Voice" })).toBeNull();
  });
});
