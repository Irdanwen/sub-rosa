import { readContextGauge, formatTokenCount } from "@subrosa/chat-core/context-gauge";
import { REASONING_EFFORTS, effortForModel } from "@subrosa/chat-core/reasoning-effort";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "../../lib/api";
import { date, t } from "../../lib/i18n";
import { DEFAULT_PERSONALIZATION, type Personalization, runTurn } from "../agent";
import { CarpeDiemError, defaultOperator, type LiveModel, type Operator } from "../carpe-diem";
import { download, exportMarkdown, fileName, replyText } from "../export";
import {
  addMessage,
  archiveChat,
  branchChat,
  listChats,
  type Message,
  messagesOf,
  restoreChat,
  rewindToLastQuestion,
  rewriteLastQuestion,
  searchChats,
} from "../library";
import { LocalState, type MemorySource, type Rating } from "../local";
import { type ChatModel, defaultChatModel, loadChatModels, speechVoice } from "../models";
import { type Reading, readAloud } from "../read-aloud";
import { availableClientStore, type ClientStore } from "../store";
import { SyncClient, type SyncTransport, serviceTransport } from "../sync";
import { ChatMessage } from "./ChatMessage";
import { SettingsDialog } from "./SettingsDialog";
import { useWorkspace } from "./useWorkspace";
import "./web-client.css";

type Key = Uint8Array<ArrayBuffer>;
type Open = { kind: "chat"; id: string } | { kind: "new" } | { kind: "temporary" };

function failureText(error: unknown): string {
  if (error instanceof CarpeDiemError) {
    if (error.code === "KEY_DAILY_CAP")
      return t(
        "This browser has spent its daily allowance. Try again later, or continue in the app.",
        "Ce navigateur a dépensé son allocation du jour. Réessayez plus tard, ou continuez dans l’app.",
      );
    if (error.code === "KEY_EXPIRED" || error.status === 401)
      return t(
        "This browser's key has expired. Renew it from your devices page.",
        "La clé de ce navigateur a expiré. Renouvelez-la depuis la page de vos appareils.",
      );
    if (error.status === 402)
      return t(
        "Your Carpe Diem balance is empty. Top up, then send again.",
        "Votre solde Carpe Diem est vide. Rechargez, puis renvoyez.",
      );
    return t(
      `The model could not answer: ${error.message}`,
      `Le modèle n’a pas pu répondre : ${error.message}`,
    );
  }
  return t(
    "This could not be completed. Check your connection and try again.",
    "Cela n’a pas abouti. Vérifiez votre connexion et réessayez.",
  );
}

/**
 * The web client: the account's chats, read and continued in a browser
 * device (ADR-0096), with the app's chat controls.
 */
export function WebClient({
  account,
  vaultKey,
  openKey,
  operator: givenOperator,
  store: givenStore,
  transport = serviceTransport,
}: {
  account: Account;
  vaultKey: Key;
  /** The browser's `cdm_` key, opened for one use, or null when it has none. */
  openKey: () => Promise<string | null>;
  operator?: Operator;
  store?: ClientStore;
  transport?: SyncTransport;
}) {
  // One operator for the page's life: a new one every render would refetch
  // the model list on every render.
  const operator = useMemo(() => givenOperator ?? defaultOperator(), [givenOperator]);
  const [sync, setSync] = useState<SyncClient | null>(null);
  const [local, setLocal] = useState<LocalState | null>(null);
  const [, setVersion] = useState(0);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [live, setLive] = useState<LiveModel[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<string>("");
  const [memoryOn, setMemoryOn] = useState(true);
  const [pastChats, setPastChats] = useState(true);
  const [personalization, setPersonalization] = useState<Personalization>(DEFAULT_PERSONALIZATION);
  const [open, setOpen] = useState<Open>({ kind: "new" });
  const [temporaryMessages, setTemporaryMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ratings, setRatings] = useState<Record<string, Rating | null>>({});
  const [sources, setSources] = useState<Record<string, MemorySource[]>>({});
  const [reading, setReading] = useState<{ id: string; reading: Reading } | null>(null);
  const [copied, setCopied] = useState("");
  const [offline, setOffline] = useState(false);
  const running = useRef<AbortController | null>(null);

  // ── Start: the cache, then the service ────────────────────────────────────
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    (async () => {
      const store = givenStore ?? (await availableClientStore());
      const client = new SyncClient(account.id, vaultKey, store, transport);
      const state = new LocalState(account.id, vaultKey, store);
      client.subscribe(() => active && setVersion((value) => value + 1));
      await client.load();
      const preferences = await state.preferences();
      const chosen = await state.personalization();
      if (!active) return;
      setSync(client);
      setLocal(state);
      setMemoryOn(preferences.memory);
      setPastChats(preferences.pastChats ?? true);
      if (preferences.model) setModel(preferences.model);
      if (preferences.effort) setEffort(preferences.effort);
      setPersonalization(chosen);
      try {
        await client.pull(controller.signal);
        await client.flush(controller.signal);
        if (active) setOffline(false);
      } catch {
        if (active) setOffline(true);
      }
    })().catch(() => active && setError(failureText(null)));
    return () => {
      active = false;
      controller.abort();
    };
  }, [account.id, vaultKey, givenStore, transport]);

  // New writes go out as soon as the network is back, and other devices'
  // changes come in while the page is open.
  useEffect(() => {
    if (!sync) return;
    const refresh = () =>
      sync
        .pull()
        .then(() => sync.flush())
        .then(() => setOffline(false))
        .catch(() => setOffline(true));
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, [sync]);

  useEffect(() => {
    const controller = new AbortController();
    loadChatModels(operator, controller.signal).then((loaded) => {
      setModels(loaded.models);
      setLive(loaded.live);
      setModel((chosen) =>
        chosen && loaded.models.some((item) => item.id === chosen)
          ? chosen
          : defaultChatModel(loaded.models),
      );
    });
    return () => controller.abort();
  }, [operator]);

  // A send can finish after the page is gone; it then says nothing.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const flush = useCallback(() => {
    sync
      ?.flush()
      .then(() => mounted.current && setOffline(false))
      .catch(() => mounted.current && setOffline(true));
  }, [sync]);

  const openChat = useCallback((id: string | null) => {
    setOpen(id ? { kind: "chat", id } : { kind: "new" });
    setError("");
  }, []);
  // Projects, assistants, pictures, library, publishing, attachments, the
  // canvas and sharing (WP20): plugged in here, built in `useWorkspace`.
  const workspace = useWorkspace({
    account,
    vaultKey,
    sync,
    local,
    operator,
    openKey,
    models,
    live,
    model,
    memoryOn,
    pastChats,
    flush,
    chatId: open.kind === "chat" ? open.id : open.kind === "temporary" ? "temporary" : null,
    openChat,
  });

  // ── What is on screen ─────────────────────────────────────────────────────
  const chats = sync ? (query.trim() ? searchChats(sync, query) : listChats(sync)) : [];
  const shownChats = chats.filter((chat) => chat.archived === showArchived);
  const current = open.kind === "chat" ? chats.find((chat) => chat.id === open.id) : undefined;
  const messages: Message[] =
    open.kind === "temporary"
      ? temporaryMessages
      : open.kind === "chat" && sync
        ? messagesOf(sync, open.id)
        : [];
  const selected = models.find((item) => item.id === model);
  const gauge = readContextGauge({
    messages: streaming ? [...messages, { content: streaming }] : messages,
    draft,
    contextTokens: selected?.contextTokens,
  });
  const offersEffort = !!selected?.supportsReasoningEffort;
  const messageIds = messages.map((message) => message.id).join(",");

  useEffect(() => {
    if (!local || !messageIds) return;
    let active = true;
    (async () => {
      const nextRatings: Record<string, Rating | null> = {};
      const nextSources: Record<string, MemorySource[]> = {};
      for (const id of messageIds.split(",")) {
        nextRatings[id] = await local.rating(id);
        const used = await local.sources(id);
        if (used) nextSources[id] = used;
      }
      if (active) {
        setRatings((value) => ({ ...value, ...nextRatings }));
        setSources((value) => ({ ...value, ...nextSources }));
      }
    })();
    return () => {
      active = false;
    };
  }, [local, messageIds]);

  const savePreferences = useCallback(
    (next: { model?: string; effort?: string; memory?: boolean; pastChats?: boolean }) => {
      void local?.setPreferences({
        model: next.model ?? model,
        effort: next.effort ?? effort,
        memory: next.memory ?? memoryOn,
        pastChats: next.pastChats ?? pastChats,
      });
    },
    [local, model, effort, memoryOn, pastChats],
  );

  // ── A turn ────────────────────────────────────────────────────────────────
  const run = async (history: Message[], chatId: string | null) => {
    if (!sync) return;
    setError("");
    const key = await openKey().catch(() => null);
    if (!key) {
      setError(
        t(
          "This browser has no Carpe Diem key yet. Get one from your devices page.",
          "Ce navigateur n’a pas encore de clé Carpe Diem. Obtenez-en une depuis la page de vos appareils.",
        ),
      );
      return;
    }
    const routed = workspace.turnModel(workspace.attachments.some((item) => item.kind === "image"));
    if ("error" in routed) {
      setError(routed.error);
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    let shown = "";
    setStreaming("");
    const temporary = chatId === null;
    try {
      const result = await runTurn(
        {
          sync,
          operator,
          key,
          model: routed.model,
          effort: effortForModel(
            { supportsReasoningEffort: offersEffort },
            REASONING_EFFORTS.find((value) => value === effort),
          ),
          memory: workspace.memoryFor(memoryOn),
          personalization,
          temporary,
          extension: workspace.plan(chatId, history),
          signal: controller.signal,
          onText: (fragment) => {
            shown += fragment;
            setStreaming(shown);
          },
          onStatus: (stage) => setStatus(stage),
        },
        history,
      );
      await finishTurn(chatId, result.answer, result.memories, routed.model);
    } catch (failure) {
      if (controller.signal.aborted) {
        // Stopped: what was already shown is kept, as the app keeps it.
        if (shown.trim()) await finishTurn(chatId, shown, [], routed.model);
      } else setError(failureText(failure));
    } finally {
      running.current = null;
      setStreaming(null);
      setStatus("");
      flush();
    }
  };

  const finishTurn = async (
    chatId: string | null,
    answer: string,
    used: { id: string; text: string }[],
    replyModel = model,
  ) => {
    if (!sync) return;
    const sourcesUsed = used.map(({ id, text }) => ({ id, text }));
    if (chatId === null) {
      const reply: Message = {
        id: crypto.randomUUID(),
        taskId: "temporary",
        role: "assistant",
        content: answer,
        createdAt: new Date().toISOString(),
      };
      setTemporaryMessages((value) => [...value, reply]);
      setSources((value) => ({ ...value, [reply.id]: sourcesUsed }));
      return;
    }
    const reply = await addMessage(sync, chatId, "assistant", answer, replyModel || null);
    if (sourcesUsed.length) {
      await local?.setSources(reply.id, sourcesUsed);
      setSources((value) => ({ ...value, [reply.id]: sourcesUsed }));
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = workspace.stored(draft.trim());
    if (!text || !sync || running.current) return;
    setDraft("");
    if (open.kind === "temporary") {
      const question: Message = {
        id: crypto.randomUUID(),
        taskId: "temporary",
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      const history = [...temporaryMessages, question];
      setTemporaryMessages(history);
      await run(history, null);
      return;
    }
    let chatId = open.kind === "chat" ? open.id : null;
    let written = false;
    if (!chatId) {
      const created = await workspace.createFor(text, model || null, draft.trim());
      chatId = created.id;
      written = created.written;
      setOpen({ kind: "chat", id: chatId });
    }
    if (!written) await addMessage(sync, chatId, "user", text, model || null);
    await run(messagesOf(sync, chatId), chatId);
  };

  const stop = () => running.current?.abort();

  const regenerate = async () => {
    if (!sync) return;
    if (open.kind === "temporary") {
      const index = temporaryMessages.map((m) => m.role).lastIndexOf("user");
      const history = temporaryMessages.slice(0, index + 1);
      setTemporaryMessages(history);
      await run(history, null);
      return;
    }
    if (open.kind !== "chat") return;
    if (await rewindToLastQuestion(sync, open.id)) await run(messagesOf(sync, open.id), open.id);
  };

  const edit = async (message: Message, content: string) => {
    if (!sync) return;
    if (open.kind === "temporary") {
      const index = temporaryMessages.findIndex((item) => item.id === message.id);
      const history = [
        ...temporaryMessages.slice(0, index),
        { ...message, content: content.trim() },
      ];
      setTemporaryMessages(history);
      await run(history, null);
      return;
    }
    if (open.kind !== "chat") return;
    if (await rewriteLastQuestion(sync, open.id, message.id, content)) {
      await run(messagesOf(sync, open.id), open.id);
      return;
    }
    // An earlier question: a branch ending on the edit, the original intact.
    const branch = await branchChat(sync, open.id, { beforeId: message.id, edited: content });
    setOpen({ kind: "chat", id: branch });
    await run(messagesOf(sync, branch), branch);
  };

  const branch = async (message: Message) => {
    if (!sync || open.kind !== "chat") return;
    const id = await branchChat(sync, open.id, { throughId: message.id });
    setOpen({ kind: "chat", id });
    flush();
  };

  const copy = async (message: Message) => {
    const text = message.role === "assistant" ? replyText(message.content) : message.content;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(message.id);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError(t("The text could not be copied.", "Le texte n’a pas pu être copié."));
    }
  };

  const toggleReading = async (message: Message) => {
    if (reading) {
      reading.reading.stop();
      const same = reading.id === message.id;
      setReading(null);
      if (same) return;
    }
    const key = await openKey().catch(() => null);
    if (!key) return;
    const next = readAloud(operator, key, message.content, speechVoice(live));
    setReading({ id: message.id, reading: next });
    next.done
      .catch(() =>
        setError(t("This reply could not be read aloud.", "Cette réponse n’a pas pu être lue.")),
      )
      .finally(() => setReading((value) => (value?.reading === next ? null : value)));
  };

  const rate = async (message: Message, rating: Rating | null) => {
    setRatings((value) => ({ ...value, [message.id]: rating }));
    await local?.setRating(message.id, rating);
  };

  const exportChat = () => {
    const title = current?.title ?? t("Temporary chat", "Discussion temporaire");
    download(
      fileName(title),
      exportMarkdown(
        title,
        messages,
        models.find((item) => item.id === current?.model)?.name ?? current?.model ?? null,
      ),
    );
  };

  const lastAssistant = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--)
      if (messages[index].role === "assistant") return messages[index].id;
    return null;
  }, [messages]);

  if (!sync)
    return (
      <section className="wc-loading" aria-busy="true">
        <p role="status">{t("Opening your chats…", "Ouverture de vos discussions…")}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    );

  const busy = streaming !== null;
  return (
    <div className="wc-shell">
      <aside className="wc-sidebar" aria-label={t("Your chats", "Vos discussions")}>
        <div className="wc-row">
          <button
            className="button primary"
            type="button"
            onClick={() => {
              setOpen({ kind: "new" });
              setError("");
              workspace.resetNewChat();
            }}
          >
            {t("New chat", "Nouvelle discussion")}
          </button>
          <button
            className="button"
            type="button"
            aria-pressed={open.kind === "temporary"}
            onClick={() => {
              setTemporaryMessages([]);
              setOpen({ kind: "temporary" });
            }}
          >
            {t("Temporary chat", "Discussion temporaire")}
          </button>
        </div>
        {workspace.nav}
        <label className="wc-search">
          <span className="sr-only">
            {t("Search your chats", "Rechercher dans vos discussions")}
          </span>
          <input
            type="search"
            value={query}
            placeholder={t("Search your chats", "Rechercher dans vos discussions")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="wc-tabs">
          <button type="button" aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>
            {t("Chats", "Discussions")}
          </button>
          <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived(true)}>
            {t("Archived", "Archivées")}
          </button>
        </div>
        <nav className="wc-list">
          {shownChats.length === 0 && (
            <p className="quiet">
              {query.trim()
                ? t("No chat matches.", "Aucune discussion ne correspond.")
                : showArchived
                  ? t("Nothing is archived.", "Rien n’est archivé.")
                  : t("No chat yet.", "Aucune discussion pour l’instant.")}
            </p>
          )}
          {shownChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className="wc-chat-row"
              aria-current={open.kind === "chat" && open.id === chat.id ? "page" : undefined}
              onClick={() => {
                setOpen({ kind: "chat", id: chat.id });
                setError("");
                if (chat.model && models.some((item) => item.id === chat.model))
                  setModel(chat.model);
              }}
            >
              <strong>{chat.title || t("Untitled chat", "Discussion sans titre")}</strong>
              {chat.updatedAt && <span className="quiet">{date(chat.updatedAt)}</span>}
            </button>
          ))}
        </nav>
        <div className="wc-sidebar-foot">
          <button className="button" type="button" onClick={() => setSettingsOpen(true)}>
            {t("Personalization and memory", "Personnalisation et mémoire")}
          </button>
          {(offline || sync.pendingCount > 0) && (
            <p className="quiet" role="status">
              {offline
                ? t(
                    "Offline. Your changes are kept here and sent when the connection returns.",
                    "Hors ligne. Vos modifications sont gardées ici et envoyées au retour de la connexion.",
                  )
                : t("Sending your changes…", "Envoi de vos modifications…")}
            </p>
          )}
          {sync.conflicts.size > 0 && (
            <p className="quiet">
              {t(
                "Some changes made elsewhere disagree with this browser. Review them in the app.",
                "Des modifications faites ailleurs ne concordent pas avec ce navigateur. Examinez-les dans l’app.",
              )}
            </p>
          )}
        </div>
      </aside>

      {workspace.mainView ?? (
        <div className={workspace.canvasPane ? "wc-with-canvas" : "wc-main-wrap"}>
          <section className="wc-main" aria-label={t("Conversation", "Conversation")}>
            <header className="wc-header">
              <h1>
                {open.kind === "temporary"
                  ? t("Temporary chat", "Discussion temporaire")
                  : (current?.title ?? t("New chat", "Nouvelle discussion"))}
              </h1>
              <div className="wc-row wc-controls">
                <label>
                  <span className="sr-only">{t("Model", "Modèle")}</span>
                  <select
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                      savePreferences({ model: event.target.value });
                    }}
                  >
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {offersEffort && (
                  <label>
                    <span className="sr-only">{t("Reasoning effort", "Effort de réflexion")}</span>
                    <select
                      value={effort}
                      onChange={(event) => {
                        setEffort(event.target.value);
                        savePreferences({ effort: event.target.value });
                      }}
                    >
                      <option value="">{t("Default effort", "Effort par défaut")}</option>
                      <option value="low">{t("Low effort", "Effort faible")}</option>
                      <option value="medium">{t("Medium effort", "Effort moyen")}</option>
                      <option value="high">{t("High effort", "Effort élevé")}</option>
                    </select>
                  </label>
                )}
                {gauge && (
                  <span
                    className={`wc-gauge ${gauge.tone === "warning" ? "warning" : ""}`}
                    role="img"
                    aria-label={t(
                      `Context used: ${formatTokenCount(gauge.used)} of ${formatTokenCount(gauge.total)} tokens`,
                      `Contexte utilisé : ${formatTokenCount(gauge.used)} sur ${formatTokenCount(gauge.total)} jetons`,
                    )}
                  >
                    <meter min={0} max={1} value={gauge.ratio} />
                    {formatTokenCount(gauge.used)} / {formatTokenCount(gauge.total)}
                  </span>
                )}
                {messages.length > 0 && (
                  <>
                    <button className="button" type="button" onClick={exportChat}>
                      {t("Export Markdown", "Exporter en Markdown")}
                    </button>
                    <button className="button" type="button" onClick={() => window.print()}>
                      {t("Print or save as PDF", "Imprimer ou enregistrer en PDF")}
                    </button>
                  </>
                )}
                {workspace.headerControls(current, messages)}
                {current && (
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      void (
                        current.archived
                          ? restoreChat(sync, current.id)
                          : archiveChat(sync, current.id)
                      ).then(flush)
                    }
                  >
                    {current.archived ? t("Restore", "Restaurer") : t("Archive", "Archiver")}
                  </button>
                )}
              </div>
            </header>
            {open.kind === "temporary" && (
              <p className="notice">
                {t(
                  "Temporary chat: nothing here is saved to your account, and the assistant writes no note and no memory.",
                  "Discussion temporaire : rien n’est enregistré sur votre compte, et l’assistant n’écrit ni note ni souvenir.",
                )}
              </p>
            )}
            {gauge?.tone === "warning" && (
              <p className="notice">
                {t(
                  "This chat is close to what the model can hold. Start a new chat to keep answers sharp.",
                  "Cette discussion approche de ce que le modèle peut contenir. Ouvrez une nouvelle discussion pour garder des réponses nettes.",
                )}
              </p>
            )}
            {!workspace.continuable(current) && (
              <p className="notice">
                {t(
                  "This chat belongs to a custom assistant. Read it here, continue it in the app.",
                  "Cette discussion appartient à un assistant personnalisé. Lisez-la ici, poursuivez-la dans l’app.",
                )}
              </p>
            )}
            {workspace.startingNotice}
            <div className="wc-messages" aria-live="polite">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  last={message.id === lastAssistant}
                  busy={busy}
                  temporary={open.kind === "temporary"}
                  reading={reading?.id === message.id}
                  rating={ratings[message.id] ?? null}
                  sources={sources[message.id]}
                  renderBlock={workspace.renderBlock}
                  extraActions={workspace.replyAction(message)}
                  actions={{
                    onCopy: (item) => void copy(item),
                    onReadAloud: (item) => void toggleReading(item),
                    onRate: (item, value) => void rate(item, value),
                    onRegenerate: () => void regenerate(),
                    onBranch: (item) => void branch(item),
                    onEdit: (item, content) => void edit(item, content),
                  }}
                />
              ))}
              {streaming !== null && (
                <article className="wc-message wc-assistant" aria-busy="true">
                  {streaming ? (
                    <p className="wc-streaming">{streaming}</p>
                  ) : (
                    <p className="quiet">{t("Thinking…", "Réflexion…")}</p>
                  )}
                  {status && status !== "thinking" && <p className="quiet">{stageLabel(status)}</p>}
                </article>
              )}
              {copied && (
                <p className="sr-only" role="status">
                  {t("Copied", "Copié")}
                </p>
              )}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {workspace.continuable(current) && (
              <form className="wc-composer" onSubmit={(event) => void send(event)}>
                {workspace.composer(busy)}
                <label className="sr-only" htmlFor="wc-draft">
                  {t("Message", "Message")}
                </label>
                <textarea
                  id="wc-draft"
                  rows={3}
                  value={draft}
                  placeholder={t("Ask anything", "Demandez ce que vous voulez")}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                {busy ? (
                  <button className="button" type="button" onClick={stop}>
                    {t("Stop", "Arrêter")}
                  </button>
                ) : (
                  <button
                    className="button primary"
                    type="submit"
                    disabled={(!draft.trim() && !workspace.attachments.length) || !model}
                  >
                    {t("Send", "Envoyer")}
                  </button>
                )}
              </form>
            )}
          </section>
          {workspace.canvasPane}
        </div>
      )}
      <SettingsDialog
        open={settingsOpen}
        personalization={personalization}
        memory={memoryOn}
        pastChats={pastChats}
        manager={workspace.memoryManager}
        onClose={() => setSettingsOpen(false)}
        onSave={(next, memory, referencePastChats) => {
          setPersonalization(next);
          setMemoryOn(memory);
          setPastChats(referencePastChats);
          void local?.setPersonalization(next);
          savePreferences({ memory, pastChats: referencePastChats });
          setSettingsOpen(false);
        }}
      />
    </div>
  );
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "searching-notes":
      return t("Searching your notes…", "Recherche dans vos notes…");
    case "searching-memory":
      return t("Searching your memories…", "Recherche dans vos souvenirs…");
    case "searching-web":
      return t("Searching the web…", "Recherche sur le web…");
    case "reading-page":
      return t("Reading a page…", "Lecture d’une page…");
    case "reading-note":
      return t("Reading a note…", "Lecture d’une note…");
    case "writing-note":
      return t("Writing a note…", "Écriture d’une note…");
    case "remembering":
      return t("Remembering…", "Mémorisation…");
    default:
      return "";
  }
}
