// A feature host for the assignments tests: a real SyncClient over the fake
// journal, a real sealed feature store, and a scripted `ask` that writes the
// question and the answer to the chat the way the page's turn does.
import type { Account } from "../../website/src/lib/api";
import type { Operator } from "../../website/src/client/carpe-diem";
import {
  type AskOptions,
  type FeatureHost,
  featureStore,
  OPEN_GUARDS,
} from "../../website/src/client/feature";
import { addMessage } from "../../website/src/client/library";
import { type ClientStore, memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal } from "./website-client-fakes";

export const ACCOUNT: Account = {
  id: "0191d1a4-0000-7000-8000-00000000a11c",
} as Account;
export const BROWSER = "0192f000-0000-7000-8000-00000000b0b0";
export const PHONE = "0192f000-0000-7000-8000-0000000f0f0f";
const KEY = () => new Uint8Array(32).fill(7);

export interface Asked {
  question: string;
  options: AskOptions;
}

export function fakeHost(
  options: {
    answer?: (question: string) => string | Error;
    operator?: Operator;
    store?: ClientStore;
    journal?: FakeJournal;
    sync?: SyncClient;
    device?: string | null;
  } = {},
) {
  const store = options.store ?? memoryClientStore();
  const journal = options.journal ?? new FakeJournal();
  const sync = options.sync ?? new SyncClient(ACCOUNT.id, KEY(), store, journal.transport());
  const asked: Asked[] = [];
  const notices: string[] = [];
  const host: FeatureHost = {
    account: ACCOUNT,
    device: {
      id: options.device === undefined ? BROWSER : options.device,
      name: "Browser - Firefox",
    },
    sync,
    vaultKey: KEY(),
    storeFor: (feature) => featureStore(ACCOUNT.id, KEY(), store, feature),
    operator: options.operator ?? {
      root: "https://operator.test",
      fetch: async () => new Response("{}", { status: 404 }),
    },
    openKey: async () => "cdm_test",
    model: "zai-org-glm-5-2",
    models: [],
    live: [],
    guards: OPEN_GUARDS,
    setGuards: () => undefined,
    memory: true,
    openChatId: null,
    busy: false,
    async ask(question, askOptions = {}) {
      asked.push({ question, options: askOptions });
      const chatId = askOptions.chatId as string;
      await addMessage(sync, chatId, "user", question, null);
      const answer = options.answer?.(question) ?? "Done.\n\n## Result\nAll good.";
      if (answer instanceof Error) throw answer;
      await addMessage(sync, chatId, "assistant", answer, null);
      return { chatId, answer, stopped: false };
    },
    stop: () => undefined,
    openChat: () => undefined,
    openPanel: () => undefined,
    notify: (text) => notices.push(text),
    refresh: () => undefined,
  };
  return { host, sync, store, journal, asked, notices };
}
