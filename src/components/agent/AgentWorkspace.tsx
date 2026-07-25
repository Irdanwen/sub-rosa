import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFileText } from "central-icons/IconFileText";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  agentItemsToChatTurns,
  applyAgentRuntimeEvent,
  createAgentRuntimeProjection,
  type AgentRuntimeProjection,
} from "../../lib/agent-runtime-adapter";
import type {
  AgentArtifactDto,
  AgentItemDto,
  AgentRuntimeEvent,
  AgentSafetyMode,
  AgentSessionDto,
} from "../../lib/agent-runtime-contract";
import {
  agentRuntimeBindings,
  downloadAgentArtifact,
  dictationHelperCommand,
  listVeniceModels,
  type VeniceModelDto,
} from "../../lib/tauri";
import { dispatchAgentSessionStatus, dispatchAgentSessionsChanged } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import {
  forgetSessionThinkingLevel,
  loadSessionThinkingLevels,
  loadThinkingLevel,
  rememberSessionThinkingLevel,
  saveThinkingLevel,
  thinkingEffortForLevel,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import {
  prepareProjectPrompt,
  ProjectContextSignatureStore,
  stripProjectContext,
} from "../../lib/agent-project-context";
import { AgentChatTurnRow } from "./chat-turns/AgentChatTurnRow";
import {
  AgentArtifactList,
  AgentArtifactPanel,
  type AgentArtifact,
  type AgentArtifactPanelState,
} from "./chat-turns/AgentArtifactPanel";
import { AgentSessionBar } from "./chat-turns/AgentSessionBar";
import { AgentThinking } from "./AgentThinking";
import {
  advanceHeroGreeting,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SHORTCUTS,
  rememberUnrestrictedAcknowledged,
  SANDBOX_OPTIONS,
  unrestrictedAcknowledged,
} from "./agent-workspace-config";
import { ComposerEditor, type ComposerEditorHandle } from "./composer/ComposerEditor";
import { agentComposerClearance } from "./composer/layout";
import {
  ComposerModelPicker,
  ComposerModelPopover,
  heroPrivacyFootnote,
  type ComposerModelFlyout,
} from "./composer/ModelPicker";
import { modelPrivacyBadge } from "../../lib/model-privacy";
import { AUTO_MODEL_ID, modelOptions, selectedModel } from "../settings/ModelPickerDialog";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import { ShareDialog } from "../share/ShareDialog";
import { buildSessionPayload } from "../../lib/share-payload";
import {
  type AgentNewSessionDetail,
  pendingNewSessionRequest,
  writeLastOpenSessionId,
  forgetLastOpenSessionId,
} from "./session-persistence";
import type { AgentWorkspaceProps } from "./agent-workspace-types";

export type { AgentWorkspaceOrigin } from "./agent-workspace-types";
export { markAgentNewSessionPending } from "./session-persistence";
export { pendingNewSessionRequest, type AgentNewSessionDetail } from "./session-persistence";
export {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_RENAMED_EVENT,
  HERO_GREETINGS,
  type AgentSessionRenamedDetail,
  type AgentSessionsChangedDetail,
} from "./agent-workspace-config";

export const AGENT_RUNTIME_EVENT = "june://agent-runtime-event";
const DEFAULT_MODEL = AUTO_MODEL_ID;
const projectContextSignaturesBySessionId = new ProjectContextSignatureStore();

export function composerInSteerStateFor(input: {
  selectedSessionId?: string;
  provisional: boolean;
  working: boolean;
  submitting: boolean;
  submittingSessionId: string | null;
  demo: boolean;
}): boolean {
  return Boolean(
    input.selectedSessionId &&
      !input.provisional &&
      (input.working ||
        (input.submitting && input.submittingSessionId === input.selectedSessionId) ||
        input.demo),
  );
}

export function canShareAgentSession(input: {
  selectedSessionId?: string;
  newSessionMode: boolean;
  provisional: boolean;
  historyLoaded: boolean;
  working: boolean;
}): boolean {
  return Boolean(
    input.selectedSessionId &&
      !input.newSessionMode &&
      !input.provisional &&
      input.historyLoaded &&
      !input.working,
  );
}

function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 52 ? `${normalized.slice(0, 51).trimEnd()}…` : normalized;
}

function artifactView(artifact: AgentArtifactDto): AgentArtifact {
  return {
    name: artifact.name,
    path: artifact.path,
    rootLabel: "June workspace",
    size: artifact.sizeBytes,
  };
}

export function AgentWorkspace({
  initialSession,
  initialSessionId,
  origin,
  onSessionSelected,
  onMoveSessionToProject,
  sessionInProject = false,
  projectContext,
  creditActionsDisabledReason,
}: AgentWorkspaceProps = {}) {
  const initialAgentSession = initialSession;
  const pendingRequestRef = useRef(pendingNewSessionRequest());
  const [sessions, setSessions] = useState<AgentSessionDto[]>(
    initialAgentSession ? [initialAgentSession] : [],
  );
  const [selectedId, setSelectedId] = useState(initialSession?.id ?? initialSessionId);
  const [newSessionMode, setNewSessionMode] = useState(!initialSession && !initialSessionId);
  const [projection, setProjection] = useState<AgentRuntimeProjection>(() =>
    createAgentRuntimeProjection({ session: initialAgentSession }),
  );
  const [artifacts, setArtifacts] = useState<AgentArtifactDto[]>([]);
  const [artifactPanel, setArtifactPanel] = useState<AgentArtifactPanelState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string>();
  const [usageOpen, setUsageOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<string>();
  const [models, setModels] = useState<VeniceModelDto[]>([]);
  const [model, setModel] = useState(initialAgentSession?.model || DEFAULT_MODEL);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => {
    const sessionLevel = initialAgentSession?.id
      ? loadSessionThinkingLevels()[initialAgentSession.id]
      : undefined;
    return sessionLevel ?? loadThinkingLevel();
  });
  const [safetyMode, setSafetyMode] = useState<AgentSafetyMode>(
    initialAgentSession?.safetyMode ?? "sandboxed",
  );
  const [draft, setDraft] = useState(pendingRequestRef.current?.prompt ?? "");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [queuedFollowUp, setQueuedFollowUp] = useState<{
    messageId: string;
    prompt: string;
    attachments: string[];
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, "once" | "session" | "always" | "deny">>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
  const [secretSubmitting, setSecretSubmitting] = useState<Record<string, true>>({});
  const [retryingFailureIds, setRetryingFailureIds] = useState<Record<string, true>>({});
  const [branchingItemId, setBranchingItemId] = useState<string>();
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [heroGreeting] = useState(advanceHeroGreeting);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const [composerClearance, setComposerClearance] = useState(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const startNewSession = useCallback(
    (request?: AgentNewSessionDetail) => {
      setSelectedId(undefined);
      selectedIdRef.current = undefined;
      setNewSessionMode(true);
      setProjection(createAgentRuntimeProjection());
      setArtifacts([]);
      setShareOpen(false);
      setShareUrl(undefined);
      setThinkingLevel(loadThinkingLevel());
      setDraft(request?.prompt ?? "");
      setAttachments([]);
      setQueuedFollowUp(undefined);
      setSubmitting(false);
      setError(undefined);
      onSessionSelected?.(undefined);
    },
    [onSessionSelected],
  );

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? projection.session;
  const running = projection.run?.status === "running" || projection.run?.status === "queued";
  const waiting = projection.run?.status === "waiting_for_user";
  const turns = useMemo(() => agentItemsToChatTurns(projection.items), [projection.items]);

  const publishSessions = useCallback((next: AgentSessionDto[]) => {
    setSessions(next);
    dispatchAgentSessionsChanged({
      sessions: next,
      selectedSessionId: selectedIdRef.current,
      workingSessionIds: next
        .filter((session) => session.status === "running")
        .map((session) => session.id),
      waitingSessionIds: next
        .filter((session) => session.status === "waiting_for_user")
        .map((session) => session.id),
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    const next = await agentRuntimeBindings.listSessions();
    publishSessions(next);
    return next;
  }, [publishSessions]);

  const hydrate = useCallback(
    async (sessionId: string) => {
      const [session, items, files, latestRun] = await Promise.all([
        agentRuntimeBindings.getSession(sessionId),
        agentRuntimeBindings.listItems(sessionId),
        agentRuntimeBindings.listArtifacts(sessionId),
        agentRuntimeBindings.getLatestRun?.(sessionId) ?? Promise.resolve(null),
      ]);
      if (selectedIdRef.current !== sessionId) return;
      setProjection({
        ...createAgentRuntimeProjection({ session, items }),
        run: latestRun ?? undefined,
      });
      setArtifacts(files);
      setModel(session.model);
      setThinkingLevel(loadSessionThinkingLevels()[session.id] ?? loadThinkingLevel());
      setSafetyMode(session.safetyMode);
      setNewSessionMode(false);
      writeLastOpenSessionId(sessionId);
      onSessionSelected?.(session);
    },
    [onSessionSelected],
  );

  useEffect(() => {
    void refreshSessions().catch((cause) => setError(messageFromError(cause)));
    void listVeniceModels("generation")
      .then((response) => {
        setModels(response.models);
        if (!initialAgentSession?.model && response.selectedModel) setModel(response.selectedModel);
      })
      .catch(() => undefined);
  }, [initialAgentSession?.model, refreshSessions]);

  useEffect(() => {
    const nextId = initialSession?.id ?? initialSessionId;
    if (!nextId) return;
    setSelectedId(nextId);
    selectedIdRef.current = nextId;
    if (initialSession) {
      setSessions((current) => [
        initialSession,
        ...current.filter((session) => session.id !== initialSession.id),
      ]);
      setProjection((current) => ({ ...current, session: initialSession }));
      setModel(initialSession.model || DEFAULT_MODEL);
      setSafetyMode(initialSession.safetyMode);
      setNewSessionMode(false);
    }
    void hydrate(nextId).catch((cause) => setError(messageFromError(cause)));
  }, [hydrate, initialSession?.id, initialSessionId]);

  useEffect(() => {
    const handleNewSession = (event: Event) => {
      const pending = pendingNewSessionRequest();
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      startNewSession(detail ?? pending);
    };
    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    return () => window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
  }, [startNewSession]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENT, ({ payload }) => {
      if (payload.sessionId !== selectedIdRef.current) {
        void refreshSessions().catch(() => undefined);
        return;
      }
      setProjection((current) => applyAgentRuntimeEvent(current, payload));
      if (payload.method === "steering.consumed") {
        setQueuedFollowUp((current) =>
          current?.messageId === payload.data.messageId ? undefined : current,
        );
      }
      dispatchAgentSessionStatus({
        sessionId: payload.sessionId,
        status:
          payload.method === "interruption.requested"
            ? "waitingForUser"
            : payload.method === "run.completed"
              ? "completed"
              : payload.method === "run.cancelled"
                ? "cancelled"
                : payload.method === "run.failed"
                  ? "failed"
                  : "running",
      });
      if (
        payload.method === "run.completed" ||
        payload.method === "run.cancelled" ||
        payload.method === "run.failed"
      ) {
        setSubmitting(false);
        void Promise.all([hydrate(payload.sessionId), refreshSessions()]);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hydrate, refreshSessions]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [projection.items]);

  useEffect(() => {
    if (running || waiting || submitting || !queuedFollowUp) return;
    const queued = queuedFollowUp;
    setQueuedFollowUp(undefined);
    setDraft(queued.prompt);
    setAttachments(queued.attachments);
    requestAnimationFrame(() => composerRef.current?.requestSubmit());
  }, [queuedFollowUp, running, submitting, waiting]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const composer = composerRef.current;
    if (newSessionMode || !selectedSession || !scroller || !composer) {
      setComposerClearance(0);
      return;
    }
    const measure = () => {
      const next = agentComposerClearance(
        scroller.getBoundingClientRect().bottom,
        composer.getBoundingClientRect().top,
      );
      setComposerClearance((current) => (current === next ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(scroller);
    observer?.observe(composer);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [newSessionMode, selectedSession]);

  useLayoutEffect(() => {
    const shell = document.querySelector(".app-shell");
    shell?.classList.toggle("app-shell-artifact-panel-open", artifactPanel !== null);
    return () => shell?.classList.remove("app-shell-artifact-panel-open");
  }, [artifactPanel]);

  useEffect(() => {
    if (!artifactPanel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setArtifactPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifactPanel]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || waiting || submitting || creditActionsDisabledReason) return;
    if (running) {
      const messageId = crypto.randomUUID();
      setQueuedFollowUp({ messageId, prompt, attachments });
      setDraft("");
      setAttachments([]);
      if (attachments.length === 0 && projection.run) {
        void agentRuntimeBindings
          .steerRun(projection.run.id, messageId, prompt)
          .catch(() => undefined);
      }
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      let session = selectedSession;
      if (!session || newSessionMode) {
        const createdSession = await agentRuntimeBindings.createSession({
          title: titleFromPrompt(prompt),
          model,
          safetyMode,
        });
        session = createdSession;
        setSelectedId(createdSession.id);
        selectedIdRef.current = createdSession.id;
        setNewSessionMode(false);
        setSessions((current) => [
          createdSession,
          ...current.filter((item) => item.id !== createdSession.id),
        ]);
        onSessionSelected?.(createdSession);
        writeLastOpenSessionId(createdSession.id);
      }
      const activeSession = session;
      const optimistic: AgentItemDto = {
        id: `optimistic:${crypto.randomUUID()}`,
        sessionId: activeSession.id,
        sequence: Math.max(0, ...projection.items.map((item) => item.sequence)) + 1,
        createdAt: new Date().toISOString(),
        kind: "message",
        role: "user",
        text: prompt,
        status: "complete",
        attachments: attachments.map((path, index) => ({
          id: `attachment:${index}:${path}`,
          sessionId: activeSession.id,
          name: path.split(/[\\/]/).pop() || path,
          path,
          action: "imported",
          available: true,
          createdAt: new Date().toISOString(),
        })),
      };
      setProjection((current) => ({
        ...current,
        session: activeSession,
        items: [...current.items, optimistic],
      }));
      setDraft("");
      const attachedPaths = attachments;
      setAttachments([]);
      const enabledSkillIds = (await agentRuntimeBindings.listSkills())
        .filter((skill) => skill.enabled)
        .map((skill) => skill.id);
      const preparedPrompt = prepareProjectPrompt(
        prompt,
        projectContext,
        projectContextSignaturesBySessionId.get(activeSession.id),
      );
      const run = await agentRuntimeBindings.startRun({
        sessionId: activeSession.id,
        prompt: preparedPrompt.text,
        model,
        reasoningEffort: thinkingEffortForLevel(thinkingLevel) as "minimal" | "medium" | "high",
        safetyMode,
        workspacePath: activeSession.workspacePath,
        enabledSkillIds,
        attachments: attachedPaths,
      });
      projectContextSignaturesBySessionId.set(activeSession.id, preparedPrompt.contextSignature);
      rememberSessionThinkingLevel(activeSession.id, thinkingLevel);
      setProjection((current) => ({ ...current, run }));
      setSubmitting(false);
      dispatchAgentSessionStatus({
        sessionId: activeSession.id,
        title: activeSession.title,
        status: "starting",
      });
      await refreshSessions();
    } catch (cause) {
      setSubmitting(false);
      setDraft((current) => current || prompt);
      setError(messageFromError(cause));
    }
  }

  async function stop() {
    if (!projection.run) return;
    try {
      await agentRuntimeBindings.cancelRun(projection.run.id);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }

  async function retryFailure(itemId: string) {
    const failedItem = projection.items.find((item) => item.id === itemId && item.kind === "error");
    if (!failedItem?.runId || running || waiting || submitting || retryingFailureIds[itemId])
      return;
    setRetryingFailureIds((current) => ({ ...current, [itemId]: true }));
    setError(undefined);
    try {
      const run = await agentRuntimeBindings.retryRun(failedItem.runId);
      setProjection((current) => ({ ...current, run }));
      dispatchAgentSessionStatus({
        sessionId: failedItem.sessionId,
        title: selectedSession?.title,
        status: "starting",
      });
      await refreshSessions();
    } catch (cause) {
      setRetryingFailureIds((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      setError(messageFromError(cause));
    }
  }

  async function respondToApproval(
    interruptionId: string,
    choice: "once" | "session" | "always" | "deny",
  ) {
    setApprovalSubmitting((current) => ({ ...current, [interruptionId]: choice }));
    try {
      const run = await agentRuntimeBindings.resolveInterruption({
        interruptionId,
        resolution: { kind: "approval", choice },
      });
      setProjection((current) => ({ ...current, run }));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setApprovalSubmitting((current) => {
        const next = { ...current };
        delete next[interruptionId];
        return next;
      });
    }
  }

  async function respondToClarification(interruptionId: string, answer: string) {
    setClarifySubmitting((current) => ({ ...current, [interruptionId]: answer }));
    try {
      const run = await agentRuntimeBindings.resolveInterruption({
        interruptionId,
        resolution: { kind: "clarification", answer },
      });
      setProjection((current) => ({ ...current, run }));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setClarifySubmitting((current) => {
        const next = { ...current };
        delete next[interruptionId];
        return next;
      });
    }
  }

  async function respondToSecret(interruptionId: string, secret: string) {
    setSecretSubmitting((current) => ({ ...current, [interruptionId]: true }));
    try {
      const run = await agentRuntimeBindings.resolveInterruption({
        interruptionId,
        resolution: secret
          ? { kind: "secret", secret, choice: "once" }
          : { kind: "secret", choice: "deny" },
      });
      setProjection((current) => ({ ...current, run }));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setSecretSubmitting((current) => {
        const next = { ...current };
        delete next[interruptionId];
        return next;
      });
    }
  }

  async function compactContext() {
    if (!selectedId || !agentRuntimeBindings.compactSession) return;
    setCompacting(true);
    setCompactResult(undefined);
    try {
      const result = await agentRuntimeBindings.compactSession(selectedId);
      setCompactResult(
        result.compacted
          ? `Context compacted. ${result.removedItems} earlier items were replaced with a summary.`
          : "There is not enough earlier context to compact yet.",
      );
      await hydrate(selectedId);
    } catch (cause) {
      setCompactResult(messageFromError(cause));
    } finally {
      setCompacting(false);
    }
  }

  async function branchFrom(itemId: string) {
    if (!selectedId || !agentRuntimeBindings.branchSession) return;
    setBranchingItemId(itemId);
    setError(undefined);
    try {
      const branch = await agentRuntimeBindings.branchSession(selectedId, itemId);
      setSessions((current) => [branch, ...current.filter((item) => item.id !== branch.id)]);
      setSelectedId(branch.id);
      selectedIdRef.current = branch.id;
      setNewSessionMode(false);
      await hydrate(branch.id);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBranchingItemId(undefined);
    }
  }

  async function pickAttachments() {
    const selected = await openFileDialog({ multiple: true, title: "Attach files" });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setAttachments((current) => [...new Set([...current, ...paths])].slice(0, 8));
  }

  async function startDictation() {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    try {
      await dictationHelperCommand({ type: "toggle_listening", shortcut: "Dictation" });
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }

  async function rename(title: string) {
    if (!selectedId) return;
    const updated = await agentRuntimeBindings.renameSession(selectedId, title);
    setSessions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setProjection((current) => ({ ...current, session: updated }));
    onSessionSelected?.(updated);
  }

  async function remove() {
    if (!selectedId) return;
    await agentRuntimeBindings.deleteSession(selectedId);
    projectContextSignaturesBySessionId.delete(selectedId);
    forgetSessionThinkingLevel(selectedId);
    forgetLastOpenSessionId(selectedId);
    setSelectedId(undefined);
    setProjection(createAgentRuntimeProjection());
    setArtifacts([]);
    setNewSessionMode(true);
    onSessionSelected?.(undefined);
    await refreshSessions();
  }

  const heroMode = newSessionMode && !selectedSession;
  const renderedArtifacts = artifacts.filter((artifact) => artifact.available).map(artifactView);
  const openArtifact = (artifact: AgentArtifact) => setArtifactPanel({ view: "file", artifact });
  const downloadArtifact = async (artifact: AgentArtifact) => {
    try {
      await downloadAgentArtifact(artifact.path);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  };
  const activeModel = selectedModel(models, model);
  const usageModel = selectedModel(
    models,
    models.some((candidate) => candidate.id === projection.run?.model)
      ? (projection.run?.model ?? model)
      : (selectedSession?.model ?? model),
  );
  const runUsage = projection.run?.usage;
  const contextLimit = usageModel?.contextTokens;
  const contextUsed = runUsage?.inputTokens;
  const contextPercent =
    contextUsed !== undefined && contextLimit !== undefined && contextLimit > 0
      ? Math.min(100, (contextUsed / contextLimit) * 100)
      : undefined;
  const estimatedCredits =
    runUsage?.inputTokens !== undefined &&
    runUsage.outputTokens !== undefined &&
    usageModel?.inputCreditsPerMillionTokens !== undefined &&
    usageModel.outputCreditsPerMillionTokens !== undefined
      ? (runUsage.inputTokens * usageModel.inputCreditsPerMillionTokens +
          runUsage.outputTokens * usageModel.outputCreditsPerMillionTokens) /
        1_000_000
      : undefined;
  const toolUsage = [...projection.items]
    .filter(
      (item) =>
        item.kind === "tool_call" &&
        (projection.run?.id === undefined || item.runId === projection.run.id),
    )
    .reduce<Map<string, { calls: number; failures: number }>>((summary, item) => {
      if (item.kind !== "tool_call") return summary;
      const current = summary.get(item.name) ?? { calls: 0, failures: 0 };
      current.calls += 1;
      if (item.status === "failed") current.failures += 1;
      summary.set(item.name, current);
      return summary;
    }, new Map());
  const composer = (
    <AgentComposer
      formRef={composerRef}
      scrollRef={scrollRef}
      draft={draft}
      setDraft={setDraft}
      model={model}
      setModel={setModel}
      thinkingLevel={thinkingLevel}
      setThinkingLevel={(level) => {
        setThinkingLevel(level);
        saveThinkingLevel(level);
        if (selectedId) rememberSessionThinkingLevel(selectedId, level);
      }}
      models={models}
      safetyMode={safetyMode}
      setSafetyMode={setSafetyMode}
      attachments={attachments}
      setAttachments={setAttachments}
      onPickAttachments={pickAttachments}
      onDictate={startDictation}
      onSubmit={submit}
      onStop={stop}
      running={running}
      submitting={submitting}
      disabledReason={creditActionsDisabledReason}
      hero={heroMode}
    />
  );
  return (
    <>
      <section
        className="agent-workspace"
        aria-label="Session"
        data-hero={heroMode ? "true" : undefined}
      >
        {!heroMode ? (
          <AgentSessionBar
            origin={origin}
            title={selectedSession?.title ?? ""}
            fullMode={selectedSession?.safetyMode === "unrestricted"}
            artifactCount={renderedArtifacts.length}
            artifactsOpen={artifactPanel !== null}
            onToggleArtifacts={() =>
              setArtifactPanel((current) => (current ? null : { view: "list" }))
            }
            inProject={sessionInProject}
            projectContext={projectContext}
            shareUrl={shareUrl}
            onShare={
              canShareAgentSession({
                selectedSessionId: selectedId,
                newSessionMode,
                provisional: false,
                historyLoaded: true,
                working: running || waiting,
              })
                ? () => setShareOpen(true)
                : undefined
            }
            onUsage={() => setUsageOpen(true)}
            onCompact={
              agentRuntimeBindings.compactSession && !running && !waiting
                ? () => {
                    setCompactResult(undefined);
                    setCompactOpen(true);
                  }
                : undefined
            }
            onRename={rename}
            onMoveToProject={
              selectedId && onMoveSessionToProject
                ? () => onMoveSessionToProject(selectedId)
                : undefined
            }
            onDelete={remove}
          />
        ) : null}
        {heroMode ? (
          <main className="agent-main" aria-label="Agent task details" data-hero="true">
            {error ? (
              <div className="agent-composer-notice" role="alert">
                {error}
              </div>
            ) : null}
            <div className="agent-hero-heading">
              <h2 className="agent-hero-title">{heroGreeting}</h2>
            </div>
            {composer}
            <div className="agent-hero-suggestions">
              <div className="agent-hero-chips" data-hidden={draft.trim() ? "true" : undefined}>
                {AGENT_SHORTCUTS.slice(0, 3).map((shortcut, index) => (
                  <button
                    key={shortcut.key}
                    type="button"
                    className="agent-hero-chip"
                    style={{ "--chip-i": index } as CSSProperties}
                    title={shortcut.description}
                    disabled={submitting}
                    onClick={() => setDraft(shortcut.prompt)}
                  >
                    <span className="agent-hero-chip-icon" aria-hidden>
                      {shortcut.icon}
                    </span>
                    {shortcut.title}
                  </button>
                ))}
              </div>
              <p className="agent-hero-footnote">
                {heroPrivacyFootnote(
                  activeModel,
                  activeModel ? modelPrivacyBadge(activeModel) : undefined,
                )}
              </p>
            </div>
          </main>
        ) : (
          <div
            ref={scrollRef}
            className="agent-scroll"
            style={{ "--agent-composer-clearance": `${composerClearance}px` } as CSSProperties}
          >
            <main className="agent-main" aria-label="Agent task details">
              {error ? (
                <div className="agent-composer-notice" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="agent-timeline">
                {turns.map((turn) => (
                  <AgentChatTurnRow
                    key={turn.id}
                    turn={turn}
                    approvalSubmitting={approvalSubmitting}
                    clarifySubmitting={clarifySubmitting}
                    sudoSubmitting={{}}
                    secretSubmitting={secretSubmitting}
                    thinkingOpen={(key) => thinkingOpen[key] ?? false}
                    onThinkingOpenChange={(key, open) =>
                      setThinkingOpen((current) => ({ ...current, [key]: open }))
                    }
                    onApproval={(part, choice) => void respondToApproval(part.id, choice)}
                    onClarify={(part, answer) => void respondToClarification(part.id, answer)}
                    onSudo={() => undefined}
                    onSecret={(part, secret) => void respondToSecret(part.id, secret)}
                    onRetryUpstreamFailure={(turnId) => void retryFailure(turnId)}
                    onBranch={(itemId) => void branchFrom(itemId)}
                    branching={branchingItemId === turn.id}
                    upstreamFailureRetryAttempted={Boolean(retryingFailureIds[turn.id])}
                    upstreamFailureRetryDisabled={running || waiting || submitting}
                  />
                ))}
                <AgentArtifactList
                  artifacts={renderedArtifacts}
                  onOpen={openArtifact}
                  onDownload={(artifact) => void downloadArtifact(artifact)}
                />
                <AgentThinking visible={running && turns.at(-1)?.role === "user"} />
              </div>
              {queuedFollowUp ? (
                <div className="agent-follow-up-row" role="status">
                  <span className="agent-follow-up-copy">
                    <span className="agent-follow-up-announcement">Queued follow-up</span>
                    <span className="agent-follow-up-text">{queuedFollowUp.prompt}</span>
                  </span>
                  <span className="agent-follow-up-actions">
                    <button
                      type="button"
                      aria-label="Remove queued follow-up"
                      onClick={() => setQueuedFollowUp(undefined)}
                    >
                      <IconCrossSmall size={12} aria-hidden />
                    </button>
                  </span>
                </div>
              ) : null}
              {composer}
            </main>
          </div>
        )}
      </section>
      {artifactPanel ? (
        <AgentArtifactPanel
          artifacts={renderedArtifacts}
          state={artifactPanel}
          onShowList={() => setArtifactPanel({ view: "list" })}
          onOpen={openArtifact}
          onDownload={(artifact) => void downloadArtifact(artifact)}
          onClose={() => setArtifactPanel(null)}
        />
      ) : null}
      {usageOpen && selectedSession ? (
        <aside className="agent-usage-panel" aria-label="Session usage">
          <div className="agent-usage-header">
            <h2 className="agent-usage-title">Usage</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close usage"
              onClick={() => setUsageOpen(false)}
            >
              <IconCrossSmall size={14} />
            </button>
          </div>
          <div className="agent-usage-body">
            <div className="agent-usage-row">
              <span className="agent-usage-primary">Model</span>
              <span className="agent-usage-value">
                {usageModel?.name ?? projection.run?.model ?? selectedSession.model}
              </span>
            </div>
            {projection.run?.usage?.provider || usageModel?.provider ? (
              <div className="agent-usage-row">
                <span className="agent-usage-primary">Provider</span>
                <span className="agent-usage-value">
                  {projection.run?.usage?.provider ?? usageModel?.provider}
                </span>
              </div>
            ) : null}
            {projection.run?.usage?.privacyLevel || usageModel?.privacy ? (
              <div className="agent-usage-row">
                <span className="agent-usage-primary">Privacy</span>
                <span className="agent-usage-value">
                  {projection.run?.usage?.privacyLevel ?? usageModel?.privacy}
                </span>
              </div>
            ) : null}
            {projection.run?.usage?.endpoint ? (
              <div className="agent-usage-row">
                <span className="agent-usage-primary">Route</span>
                <span className="agent-usage-value">{projection.run.usage.endpoint}</span>
              </div>
            ) : null}
            {projection.run?.reasoningEffort ? (
              <div className="agent-usage-row">
                <span className="agent-usage-primary">Reasoning effort</span>
                <span className="agent-usage-value">{projection.run.reasoningEffort}</span>
              </div>
            ) : null}
            {projection.run?.usage ? (
              <>
                {projection.run.usage.inputTokens !== undefined ? (
                  <div className="agent-usage-row">
                    <span className="agent-usage-primary">Input</span>
                    <span className="agent-usage-value">
                      {projection.run.usage.inputTokens.toLocaleString()}
                    </span>
                  </div>
                ) : null}
                {projection.run.usage.outputTokens !== undefined ? (
                  <div className="agent-usage-row">
                    <span className="agent-usage-primary">Output</span>
                    <span className="agent-usage-value">
                      {projection.run.usage.outputTokens.toLocaleString()}
                    </span>
                  </div>
                ) : null}
                {projection.run.usage.totalTokens !== undefined ? (
                  <div className="agent-usage-row">
                    <span className="agent-usage-primary">Total</span>
                    <span className="agent-usage-value">
                      {projection.run.usage.totalTokens.toLocaleString()}
                    </span>
                  </div>
                ) : null}
                {projection.run.usage.inputTokens === undefined &&
                projection.run.usage.outputTokens === undefined &&
                projection.run.usage.totalTokens === undefined ? (
                  <p className="agent-usage-empty">
                    Token counts were not reported for this request.
                  </p>
                ) : null}
                {contextPercent !== undefined && contextUsed !== undefined && contextLimit ? (
                  <div className="agent-usage-context">
                    <div className="agent-usage-row">
                      <span className="agent-usage-primary">Latest request context</span>
                      <span className="agent-usage-value">
                        {contextUsed.toLocaleString()} of {contextLimit.toLocaleString()} (
                        {contextPercent.toFixed(1)}%)
                      </span>
                    </div>
                    <div
                      className="agent-usage-context-track"
                      role="progressbar"
                      aria-label="Context used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(contextPercent)}
                    >
                      <span style={{ transform: `scaleX(${contextPercent / 100})` }} />
                    </div>
                  </div>
                ) : null}
                {estimatedCredits !== undefined ? (
                  <div className="agent-usage-row">
                    <span className="agent-usage-primary">Estimated charge</span>
                    <span className="agent-usage-value">
                      {estimatedCredits.toLocaleString(undefined, {
                        maximumFractionDigits: estimatedCredits < 1 ? 3 : 1,
                      })}{" "}
                      credits (about ${(estimatedCredits / 1_000).toFixed(4)})
                    </span>
                  </div>
                ) : null}
                {toolUsage.size > 0 ? (
                  <div className="agent-usage-tools">
                    <p className="agent-usage-section-title">Tools</p>
                    {[...toolUsage.entries()].map(([name, usage]) => (
                      <div className="agent-usage-row" key={name}>
                        <span className="agent-usage-primary">{name}</span>
                        <span className="agent-usage-value">
                          {usage.calls} {usage.calls === 1 ? "call" : "calls"}
                          {usage.failures > 0 ? `, ${usage.failures} failed` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="agent-usage-empty">No usage reported for this session yet.</p>
            )}
          </div>
        </aside>
      ) : null}
      {selectedSession ? (
        <ShareDialog
          key={selectedSession.id}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onLinkChange={(url) => setShareUrl(url ?? undefined)}
          item={{
            kind: "session",
            itemId: selectedSession.id,
            title: selectedSession.title,
            buildPayload: () =>
              buildSessionPayload({
                title: selectedSession.title,
                messages: projection.items.flatMap((item) =>
                  item.kind === "message" && (item.role === "user" || item.role === "assistant")
                    ? [
                        {
                          role: item.role,
                          content:
                            item.role === "user" ? stripProjectContext(item.text) : item.text,
                        },
                      ]
                    : [],
                ),
              }),
          }}
        />
      ) : null}
      <Dialog
        open={compactOpen}
        onClose={() => {
          if (!compacting) setCompactOpen(false);
        }}
        title="Compact context?"
        description="June will replace older conversation turns with one visible summary and keep recent turns unchanged."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              disabled={compacting}
              onClick={() => setCompactOpen(false)}
            >
              {compactResult ? "Close" : "Cancel"}
            </button>
            {!compactResult ? (
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={compacting}
                onClick={() => void compactContext()}
              >
                {compacting ? "Compacting" : "Compact context"}
              </button>
            ) : null}
          </>
        }
      >
        {compactResult ? <p role="status">{compactResult}</p> : null}
      </Dialog>
    </>
  );
}

function AgentComposer({
  formRef,
  scrollRef,
  draft,
  setDraft,
  model,
  setModel,
  thinkingLevel,
  setThinkingLevel,
  models,
  safetyMode,
  setSafetyMode,
  attachments,
  setAttachments,
  onPickAttachments,
  onDictate,
  onSubmit,
  onStop,
  running,
  submitting,
  disabledReason,
  hero = false,
}: {
  formRef: RefObject<HTMLFormElement>;
  scrollRef: RefObject<HTMLDivElement>;
  draft: string;
  setDraft: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (value: ThinkingLevel) => void;
  models: VeniceModelDto[];
  safetyMode: AgentSafetyMode;
  setSafetyMode: (value: AgentSafetyMode) => void;
  attachments: string[];
  setAttachments: (value: string[]) => void;
  onPickAttachments: () => Promise<void>;
  onDictate: () => Promise<void>;
  onSubmit: (event?: FormEvent) => Promise<void>;
  onStop: () => Promise<void>;
  running: boolean;
  submitting: boolean;
  disabledReason?: string;
  hero?: boolean;
}) {
  const editorRef = useRef<ComposerEditorHandle>(null);
  const publishedDraftRef = useRef(draft);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<ComposerModelFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const safetyTriggerRef = useRef<HTMLButtonElement>(null);
  const safetyMenuRef = useRef<HTMLDivElement>(null);
  const activeModel = selectedModel(models, model);
  const working = running || submitting;

  useEffect(() => {
    if (draft === publishedDraftRef.current) return;
    publishedDraftRef.current = draft;
    editorRef.current?.setContent(draft, null, { focus: false });
  }, [draft]);

  useEffect(() => {
    if (!modelOpen && !safetyOpen && !attachOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelPopoverRef.current?.contains(target) || modelTriggerRef.current?.contains(target)) {
        return;
      }
      if (safetyTriggerRef.current?.contains(target)) return;
      if (safetyMenuRef.current?.contains(target)) return;
      if (attachTriggerRef.current?.contains(target) || attachMenuRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      setModelOpen(false);
      setSafetyOpen(false);
      setAttachOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [attachOpen, modelOpen, safetyOpen]);

  function referenceNote() {
    const prefix = draft && !/\s$/.test(draft) ? " @" : "@";
    const next = `${draft}${prefix}`;
    publishedDraftRef.current = next;
    setDraft(next);
    editorRef.current?.setContent(next, null, { focus: true });
  }

  return (
    <form
      ref={formRef}
      className="agent-composer"
      data-hero={hero ? "true" : undefined}
      onSubmit={(event) => void onSubmit(event)}
    >
      {hero ? null : (
        <AgentScrollToLatestButton
          scrollRef={scrollRef}
          onJump={() =>
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
          }
        />
      )}
      <div className="agent-composer-box">
        {attachments.length ? (
          <div className="agent-composer-attachments">
            {attachments.map((path) => (
              <span key={path} className="agent-attachment-tile">
                <IconFileText size={16} />
                <span>{path.split(/[\\/]/).pop() || path}</span>
                <button
                  type="button"
                  aria-label={`Remove ${path.split(/[\\/]/).pop() || path}`}
                  onClick={() => setAttachments(attachments.filter((item) => item !== path))}
                >
                  <IconCrossSmall size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <ComposerEditor
          ref={editorRef}
          placeholder={hero ? "Ask June anything, run / commands" : "Send a message"}
          onChange={(text) => {
            publishedDraftRef.current = text;
            setDraft(text);
          }}
          onSubmit={() => void onSubmit()}
        />
        <div className="agent-composer-toolbar">
          <button
            type="button"
            ref={attachTriggerRef}
            className="agent-composer-attach"
            aria-label="Add files or notes"
            title="Add"
            aria-haspopup="menu"
            aria-expanded={attachOpen}
            data-open={attachOpen || undefined}
            onClick={() => setAttachOpen((open) => !open)}
          >
            <IconPlusMedium size={18} />
          </button>
          {hero ? (
            <button
              ref={safetyTriggerRef}
              type="button"
              className="agent-sandbox-trigger"
              data-unrestricted={safetyMode === "unrestricted" ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={safetyOpen}
              title="Change what June can touch"
              onClick={() => setSafetyOpen((open) => !open)}
            >
              {safetyMode === "sandboxed" ? (
                <IconShieldCheck size={14} />
              ) : (
                <IconShieldCrossed size={14} />
              )}
              {safetyMode === "sandboxed" ? "Sandboxed" : "Unrestricted"}
              <IconChevronDownSmall size={12} aria-hidden />
            </button>
          ) : null}
          <div className="agent-composer-actions">
            <ComposerModelPicker
              open={modelOpen}
              model={activeModel}
              effort={thinkingLevel}
              readOnly={working}
              triggerRef={modelTriggerRef}
              onToggleOpen={() => setModelOpen((open) => !open)}
            />
            <button
              type="button"
              className="agent-composer-mic"
              aria-label="Dictate"
              title={disabledReason ?? "Start dictation"}
              disabled={Boolean(disabledReason)}
              onClick={() => {
                editorRef.current?.focus();
                void onDictate();
              }}
            >
              <IconMicrophone size={18} />
            </button>
            {running ? (
              <>
                {draft.trim() ? (
                  <button
                    type="submit"
                    className="agent-composer-send"
                    aria-label="Queue follow-up"
                  >
                    <IconArrowUp size={18} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="agent-composer-stop"
                  aria-label="Stop June"
                  onClick={() => void onStop()}
                >
                  <IconStop size={16} />
                </button>
              </>
            ) : (
              <button
                type="submit"
                className="agent-composer-send"
                aria-label="Send message"
                disabled={submitting || !draft.trim() || Boolean(disabledReason)}
                title={disabledReason}
              >
                {submitting ? <Spinner /> : <IconArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {attachOpen ? (
        <div
          ref={attachMenuRef}
          className="agent-attach-menu"
          role="menu"
          aria-label="Add files or notes"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachOpen(false);
              void onPickAttachments();
            }}
          >
            <span className="agent-attach-menu-icon">
              <IconFileText size={16} aria-hidden />
            </span>
            <span className="agent-attach-menu-label">Attach files</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachOpen(false);
              referenceNote();
            }}
          >
            <span className="agent-attach-menu-icon">
              <IconNoteText size={16} aria-hidden />
            </span>
            <span className="agent-attach-menu-label">Reference a note</span>
          </button>
        </div>
      ) : null}
      {hero && safetyOpen ? (
        <div
          ref={safetyMenuRef}
          className="agent-sandbox-menu"
          role="menu"
          aria-label="Safety mode"
        >
          <p className="agent-sandbox-menu-title">Choose what June can touch</p>
          {SANDBOX_OPTIONS.map((option) => {
            const value: AgentSafetyMode = option.unrestricted ? "unrestricted" : "sandboxed";
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={safetyMode === value}
                onClick={() => {
                  setSafetyOpen(false);
                  if (value === "unrestricted" && !unrestrictedAcknowledged()) {
                    setConfirmUnrestricted(true);
                    return;
                  }
                  setSafetyMode(value);
                }}
              >
                {option.icon}
                <span className="agent-sandbox-option">
                  <span className="agent-sandbox-option-title">{option.title}</span>
                  <span className="agent-sandbox-option-desc">{option.description}</span>
                </span>
                {safetyMode === value ? (
                  <IconCheckmark2Small
                    size={14}
                    aria-hidden
                    className="agent-sandbox-option-check"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {modelOpen ? (
        <ComposerModelPopover
          flyout={modelFlyout}
          model={activeModel}
          options={modelOptions(models, model)}
          search={modelSearch}
          popoverRef={modelPopoverRef}
          searchRef={modelSearchRef}
          thinkingLevel={thinkingLevel}
          onFlyoutChange={setModelFlyout}
          onSearchChange={setModelSearch}
          onSelect={(nextModel) => {
            setModel(nextModel);
            setModelOpen(false);
          }}
          onSelectThinking={(level) => {
            setThinkingLevel(level);
            setModelFlyout(null);
          }}
        />
      ) : null}
      <Dialog
        open={confirmUnrestricted}
        onClose={() => setConfirmUnrestricted(false)}
        title="Turn on Unrestricted?"
        description="June will be able to change any file your account can, not just its own workspace. This comes with risks like data loss if something goes wrong."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => setConfirmUnrestricted(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => {
                rememberUnrestrictedAcknowledged();
                setSafetyMode("unrestricted");
                setConfirmUnrestricted(false);
              }}
            >
              Turn on Unrestricted
            </button>
          </>
        }
      >
        {null}
      </Dialog>
    </form>
  );
}

function AgentScrollToLatestButton({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  onJump: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const recheck = () => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      setVisible(scroller.scrollHeight > scroller.clientHeight && distanceFromBottom > 48);
    };
    recheck();
    scroller.addEventListener("scroll", recheck, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(recheck) : undefined;
    observer?.observe(scroller);
    for (const child of Array.from(scroller.children)) observer?.observe(child);
    return () => {
      scroller.removeEventListener("scroll", recheck);
      observer?.disconnect();
    };
  }, [scrollRef]);

  return (
    <button
      type="button"
      className="agent-scroll-to-latest"
      data-visible={visible ? "true" : undefined}
      aria-label="Scroll to latest"
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      onClick={onJump}
    >
      <IconArrowDown size={16} ariaHidden />
    </button>
  );
}
