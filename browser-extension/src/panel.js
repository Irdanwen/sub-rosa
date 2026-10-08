/**
 * The side panel and the popup: one page, two surfaces
 * (`body[data-surface]`). It reads the page only when a button asks for it,
 * through `activeTab`, and sends what it read to the desktop app, which runs
 * the turn and streams the answer back.
 */

import { readPage } from "./page.js";
import {
  HOST_NAME,
  ProtocolError,
  applyStreamStep,
  clipPage,
  createClient,
  detectBrowser,
  errorMessageKey,
  isReadableUrl,
  normalizeCode,
  stageMessageKey,
  stripChatBlocks,
} from "./protocol.js";

const ext = globalThis.browser ?? globalThis.chrome;
const surface = document.body.dataset.surface ?? "panel";

/** @param {string} key @param {string[]} [substitutions] */
const msg = (key, substitutions) => ext.i18n.getMessage(key, substitutions) || key;

const client = createClient(
  () => ext.runtime.connectNative(HOST_NAME),
  () => ext.runtime.lastError?.message,
);

const $ = (id) => /** @type {any} */ (document.getElementById(id));

const state = {
  /** @type {string | null} */
  token: null,
  /** @type {string | null} */
  conversationId: null,
  /** @type {{ role: "user" | "assistant", text: string, node: HTMLElement }[]} */
  messages: [],
  /** @type {{ id: string } | null} */
  streaming: null,
  /** @type {{ text: string, url: string, title: string } | null} */
  selection: null,
  /** Read at start: opening the side panel must happen inside the click. */
  /** @type {number | undefined} */
  windowId: undefined,
};

function localize() {
  document.documentElement.lang = ext.i18n.getUILanguage?.() ?? "en";
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = msg(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", msg(node.dataset.i18nPlaceholder));
  }
}

function notice(text, tone = "info") {
  const node = $("notice");
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = !text;
}

function showError(error) {
  const code = error instanceof ProtocolError ? error.code : "generic";
  if (code === "not_paired") {
    forgetLocally();
  }
  notice(msg(errorMessageKey(code)), "error");
}

function show(view) {
  $("pair").hidden = view !== "pair";
  $("main").hidden = view !== "main";
}

async function storedToken() {
  const stored = await ext.storage.local.get("pairing");
  return stored?.pairing?.token ?? null;
}

function forgetLocally() {
  state.token = null;
  ext.storage.local.remove("pairing");
  show("pair");
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

async function activeTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** The page as the click that asked for it allows reading it. */
async function readActivePage() {
  const tab = await activeTab();
  if (!tab?.id) throw new ProtocolError("no_access");
  let page;
  try {
    const [result] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPage,
    });
    page = clipPage(result?.result);
  } catch {
    // Not granted (the panel was opened earlier and the tab moved on), or a
    // page no extension may read.
    throw new ProtocolError(isReadableUrl(tab.url) ? "no_access" : "page_not_supported");
  }
  if (!isReadableUrl(page.url)) throw new ProtocolError("page_not_supported");
  return page;
}

/* ------------------------------------------------------------------ *
 * The thread
 * ------------------------------------------------------------------ */

function addMessage(role, text) {
  const node = document.createElement("li");
  node.className = "message";
  node.dataset.role = role;
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = msg(role === "user" ? "you" : "assistant");
  const body = document.createElement("span");
  body.className = "message-body";
  body.textContent = text;
  node.append(author, body);
  $("thread").append(node);
  const message = { role, text, node: body };
  state.messages.push(message);
  node.scrollIntoView({ block: "end" });
  return message;
}

function setText(message, text) {
  message.text = text;
  message.node.textContent = stripChatBlocks(text);
}

function setStreaming(streaming) {
  state.streaming = streaming;
  $("stop").hidden = !streaming;
  $("send").disabled = Boolean(streaming);
  $("summarize").disabled = Boolean(streaming);
  $("stage").hidden = !streaming;
  if (streaming) $("stage").textContent = msg("stageThinking");
}

function lastAnswer() {
  const answer = [...state.messages].reverse().find((message) => message.role === "assistant");
  return answer ? stripChatBlocks(answer.text) : "";
}

function setSelection(selection) {
  state.selection = selection?.text ? selection : null;
  $("selection").hidden = !state.selection;
  $("selection-text").textContent = state.selection?.text ?? "";
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function ask(question, includePage) {
  if (!question.trim()) {
    notice(msg("errorEmptyQuestion"), "error");
    return;
  }
  notice("");
  let page = null;
  try {
    if (includePage) {
      page = await readActivePage();
    } else if (state.selection && isReadableUrl(state.selection.url)) {
      page = clipPage({ url: state.selection.url, title: state.selection.title });
    }
    if (page && state.selection) page.selection = state.selection.text;
  } catch (error) {
    showError(error);
    return;
  }
  const firstTurn = !state.conversationId;
  addMessage("user", question);
  const answer = addMessage("assistant", "");
  setSelection(null);
  setStreaming({ id: "pending" });
  try {
    const done = await client.request(
      "ask",
      {
        token: state.token,
        question,
        ...(page ? { page } : {}),
        ...(state.conversationId ? { conversationId: state.conversationId } : {}),
      },
      (event) => {
        if (event.type === "started") state.conversationId = event.conversationId;
        else if (event.type === "status")
          $("stage").textContent = msg(stageMessageKey(event.stage));
        else setText(answer, applyStreamStep(answer.text, event));
      },
    );
    state.conversationId = done.conversationId;
    setText(answer, done.text || answer.text);
    if (firstTurn) notice(msg("continuesInApp"));
  } catch (error) {
    if (!answer.text) {
      answer.node.parentElement?.remove();
      state.messages = state.messages.filter((message) => message !== answer);
    }
    showError(error);
  } finally {
    setStreaming(null);
  }
}

async function addToNote() {
  notice("");
  try {
    const page = await readActivePage();
    if (state.selection) page.selection = state.selection.text;
    const saved = await client.request("add_to_note", {
      token: state.token,
      page: { url: page.url, title: page.title, selection: page.selection },
      text: lastAnswer(),
    });
    notice(msg("noteSaved", [saved.title]));
  } catch (error) {
    showError(error);
  }
}

async function saveLink() {
  notice("");
  try {
    const page = await readActivePage();
    const saved = await client.request("save_link", {
      token: state.token,
      page: { url: page.url, title: page.title },
    });
    notice(msg("linkSaved", [saved.title]));
  } catch (error) {
    showError(error);
  }
}

async function pair(event) {
  event.preventDefault();
  notice("");
  const code = normalizeCode($("code").value);
  try {
    const paired = await client.request("pair", {
      code,
      browser: detectBrowser(navigator.userAgent, {
        brave: Boolean(/** @type {any} */ (navigator).brave),
        firefox: Boolean(globalThis.browser?.runtime?.getBrowserInfo),
      }),
    });
    state.token = paired.token;
    await ext.storage.local.set({ pairing: { token: paired.token, pairedAt: Date.now() } });
    $("code").value = "";
    show("main");
    notice(msg("paired"));
  } catch (error) {
    showError(error);
  }
}

async function unpair() {
  try {
    await client.request("unpair", { token: state.token });
  } catch {
    // Forgotten here either way: without this copy the token is useless,
    // and Settings in the app can remove the entry.
  }
  forgetLocally();
}

function stop() {
  if (!state.conversationId) return;
  client.send("cancel", { token: state.token, conversationId: state.conversationId });
}

function newChat() {
  state.conversationId = null;
  state.messages = [];
  $("thread").replaceChildren();
  notice("");
}

async function openSidePanel() {
  try {
    if (ext.sidePanel?.open && state.windowId !== undefined) {
      await ext.sidePanel.open({ windowId: state.windowId });
    } else {
      await ext.sidebarAction?.open();
    }
    window.close();
  } catch {
    showError(new ProtocolError("generic"));
  }
}

async function takePendingSelection() {
  const stored = await ext.storage.session.get("pendingSelection");
  const pending = stored?.pendingSelection;
  if (!pending) return;
  await ext.storage.session.remove("pendingSelection");
  setSelection(pending);
  $("include-page").checked = false;
  $("question").focus();
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function start() {
  localize();
  $("open-panel").hidden = surface !== "popup";
  $("pair-form").addEventListener("submit", pair);
  $("ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const question = $("question").value;
    $("question").value = "";
    ask(question, $("include-page").checked);
  });
  $("question").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("ask-form").requestSubmit();
    }
  });
  $("summarize").addEventListener("click", () => ask(msg("summarizePrompt"), true));
  $("add-note").addEventListener("click", addToNote);
  $("save-link").addEventListener("click", saveLink);
  $("open-panel").addEventListener("click", openSidePanel);
  $("stop").addEventListener("click", stop);
  $("new-chat").addEventListener("click", newChat);
  $("forget").addEventListener("click", unpair);
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.pendingSelection?.newValue) takePendingSelection();
  });

  state.token = await storedToken();
  state.windowId = (await activeTab())?.windowId;
  try {
    const hello = await client.request("hello", state.token ? { token: state.token } : {});
    if (hello.paired) {
      show("main");
      await takePendingSelection();
    } else {
      if (state.token) forgetLocally();
      show("pair");
    }
  } catch (error) {
    show(state.token ? "main" : "pair");
    showError(error);
  }
}

start();
