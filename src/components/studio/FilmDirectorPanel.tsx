// Director mode (ADR-0010, phase 3): the hands-on view of one gated film
// project — chat with the studio crew, approve/reject phase gates, launch
// production through the cost handshake, and review the shot board (takes,
// retakes, requeues, skips).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FILM_REF_ROLE_LABELS,
  FILM_REF_ROLES,
  type FilmBoard,
  type FilmBriefRef,
  type FilmChatMessage,
  type FilmCrewEvent,
  type FilmGate,
  type FilmProject,
  type FilmStatus,
  type FilmTake,
  filmRefLine,
  listenFilmChatEvents,
  parseBoard,
  parseCrewEvent,
  parseGates,
  parseTakes,
  parseTranscript,
  parseUploadedRef,
} from "../../lib/films";
import { readFilmRef } from "../../lib/films/refs";
import {
  videomakerBoard,
  videomakerChat,
  videomakerGateApprove,
  videomakerGateReject,
  videomakerGates,
  videomakerImproveBrief,
  videomakerShotRequeue,
  videomakerShotRetake,
  videomakerShotSkip,
  videomakerShotTakes,
  videomakerTakeSelect,
  videomakerTranscript,
  videomakerUploadRef,
} from "../../lib/tauri";
import { Spinner } from "../ui/Spinner";
import { PillGroup } from "./controls";
import { FilmProduceControl } from "./FilmProduceControl";

/// One department the studio delegated to during the current turn.
type CrewStep = FilmCrewEvent & { key: string };

type ErrorLike = { message?: string };

function errorMessage(error: unknown): string {
  const message = (error as ErrorLike)?.message;
  return typeof message === "string" && message ? message : "Something went wrong.";
}

function gateBadge(gate: FilmGate): string {
  if (gate.open || gate.status === "approved") return "approved";
  if (gate.status === "rejected") return "rejected";
  return "pending";
}

export function FilmDirectorPanel({
  project,
  status,
  initialDraft,
}: {
  project: FilmProject;
  /** The project's `/status` rollup (owned by the studio surface above). */
  status?: FilmStatus;
  /** Seeds the chat composer (e.g. the refs manifest handed off at creation). */
  initialDraft?: string;
}) {
  const slug = project.slug;
  const [gates, setGates] = useState<FilmGate[]>([]);
  const [board, setBoard] = useState<FilmBoard | null>(null);
  const [messages, setMessages] = useState<FilmChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat turn state.
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnActivity, setTurnActivity] = useState<string | null>(null);
  // Which departments the studio put on the job this turn. Most of a turn's
  // work is delegated now, so without these the panel would spin on
  // "Thinking..." while a whole crew is running.
  const [crew, setCrew] = useState<CrewStep[]>([]);
  // Attach flow: pick → set role/name → upload on confirm.
  const [pendingAttach, setPendingAttach] = useState<FilmBriefRef | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  // AI improvement of the drafted message (preview, never a silent rewrite).
  const [improving, setImproving] = useState(false);
  const [improvedDraft, setImprovedDraft] = useState<string | null>(null);

  // Gate decision state.
  const [rejectingPhase, setRejectingPhase] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [gateBusy, setGateBusy] = useState<string | null>(null);

  // Shot actions.
  const [openShot, setOpenShot] = useState<string | null>(null);
  const [takesByShot, setTakesByShot] = useState<Record<string, FilmTake[]>>({});
  const [shotBusy, setShotBusy] = useState<string | null>(null);
  const [retakePrompt, setRetakePrompt] = useState("");

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [gatesRaw, boardRaw, transcriptRaw] = await Promise.all([
        videomakerGates(slug),
        videomakerBoard(slug),
        videomakerTranscript(slug),
      ]);
      setGates(parseGates(gatesRaw));
      setBoard(parseBoard(boardRaw));
      setMessages(parseTranscript(transcriptRaw));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Tool + crew progress while a chat turn runs.
  useEffect(() => {
    return listenFilmChatEvents((event) => {
      if (event.slug !== slug) return;
      if (event.kind === "tool") {
        const data = event.data as { label?: string; tool?: string; phase?: string };
        if (data?.phase === "start") {
          setTurnActivity(data.label ?? data.tool ?? "Working");
        }
        return;
      }
      if (event.kind !== "agent") return;
      const delegation = parseCrewEvent(event.data);
      if (!delegation) return;
      if (!delegation.done) {
        setTurnActivity(
          delegation.goal ? `${delegation.label}: ${delegation.goal}` : delegation.label,
        );
        setCrew((current) => [
          ...current,
          { ...delegation, key: `${delegation.role}:${delegation.taskId ?? current.length}` },
        ]);
        return;
      }
      // Resolve the matching start (same task when the studio gave an id, else
      // the department's oldest unfinished job).
      setCrew((current) => {
        const index = current.findIndex(
          (step) =>
            !step.done &&
            step.role === delegation.role &&
            (delegation.taskId === undefined || step.taskId === delegation.taskId),
        );
        if (index < 0) return current;
        const next = [...current];
        next[index] = { ...next[index], ...delegation, key: next[index].key };
        return next;
      });
    });
  }, [slug]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new message / turn state
  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, turnBusy]);

  const sendMessage = useCallback(async () => {
    const message = draft.trim();
    if (!message || turnBusy) return;
    setDraft("");
    setImprovedDraft(null);
    setTurnBusy(true);
    setTurnActivity(null);
    setCrew([]);
    setError(null);
    setMessages((current) => [...current, { role: "user", content: message }]);
    try {
      const done = await videomakerChat(slug, message);
      // The server transcript normally already contains this turn; the append
      // below only covers a transcript that lags behind the stream's reply.
      await refresh();
      const reply = (done as { reply?: string }).reply;
      if (typeof reply === "string" && reply.trim()) {
        setMessages((current) =>
          current.some((entry) => entry.role === "assistant" && entry.content === reply)
            ? current
            : [...current, { role: "assistant", content: reply }],
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTurnBusy(false);
      setTurnActivity(null);
    }
  }, [draft, turnBusy, slug, refresh]);

  /// Stage a picked image: the user assigns a role and a name before the
  /// upload, so the crew knows what the reference anchors.
  const pickAttachment = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    try {
      setPendingAttach(await readFilmRef(file, "character"));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  /// Upload the staged image and hand its signed URL to the crew via the
  /// composer draft (the user can still edit or annotate before sending).
  const confirmAttachment = useCallback(async () => {
    if (!pendingAttach || attachBusy) return;
    setAttachBusy(true);
    setError(null);
    try {
      const parsed = parseUploadedRef(
        await videomakerUploadRef({
          slug,
          fileName: pendingAttach.fileName,
          base64Data: pendingAttach.base64Data,
        }),
      );
      if (!parsed) {
        throw new Error(`The studio did not accept "${pendingAttach.fileName}".`);
      }
      const line = filmRefLine({
        role: pendingAttach.role,
        label: pendingAttach.label,
        url: parsed.publicUrl,
      });
      setDraft((current) => (current.trim() ? `${current}\n${line}` : line));
      setPendingAttach(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAttachBusy(false);
    }
  }, [slug, pendingAttach, attachBusy]);

  /// Sharpen the drafted message. A brand-new project gets the full brief
  /// treatment (the first chat message IS the brief); mid-project notes get
  /// the lighter "direction" pass.
  const improveDraft = useCallback(async () => {
    const message = draft.trim();
    if (!message || improving) return;
    setImproving(true);
    setError(null);
    try {
      const improved = await videomakerImproveBrief({
        brief: message,
        title: project.title,
        mode: messages.length === 0 ? "brief" : "direction",
      });
      setImprovedDraft(improved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImproving(false);
    }
  }, [draft, improving, project.title, messages.length]);

  const decideGate = useCallback(
    async (phase: string, approve: boolean, reason?: string) => {
      setGateBusy(phase);
      setError(null);
      try {
        if (approve) {
          await videomakerGateApprove({ slug, phase, decisionReason: reason });
        } else {
          await videomakerGateReject({ slug, phase, decisionReason: reason });
        }
        setRejectingPhase(null);
        setRejectReason("");
        await refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setGateBusy(null);
      }
    },
    [slug, refresh],
  );

  const toggleShot = useCallback(
    async (shotId: string) => {
      if (openShot === shotId) {
        setOpenShot(null);
        return;
      }
      setOpenShot(shotId);
      setRetakePrompt("");
      try {
        const takes = parseTakes(await videomakerShotTakes(slug, shotId));
        setTakesByShot((current) => ({ ...current, [shotId]: takes }));
      } catch {
        // Takes stay collapsed-empty; the actions below still work.
      }
    },
    [openShot, slug],
  );

  const shotAction = useCallback(
    async (shotId: string, action: () => Promise<unknown>) => {
      setShotBusy(shotId);
      setError(null);
      try {
        await action();
        const takes = parseTakes(await videomakerShotTakes(slug, shotId));
        setTakesByShot((current) => ({ ...current, [shotId]: takes }));
        await refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setShotBusy(null);
      }
    },
    [slug, refresh],
  );

  if (loading) {
    return (
      <div className="film-director-loading">
        <Spinner aria-label="Loading the project" />
      </div>
    );
  }

  return (
    <div className="film-director">
      {error ? <p className="studio-error">{error}</p> : null}

      <section className="film-gates" aria-label="Phase gates">
        {gates.map((gate) => {
          const badge = gateBadge(gate);
          const busy = gateBusy === gate.phase;
          return (
            <div key={gate.phase} className="film-gate" data-status={badge}>
              <span className="film-gate-name">{gate.phase.replaceAll("_", " ")}</span>
              <span className="film-gate-badge">{badge}</span>
              {badge === "pending" || badge === "rejected" ? (
                <span className="film-gate-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void decideGate(gate.phase, true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setRejectingPhase(gate.phase)}
                  >
                    Reject
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
        {rejectingPhase ? (
          <div className="film-gate-reject">
            <input
              className="studio-input"
              type="text"
              value={rejectReason}
              placeholder="Why is this phase rejected? The crew reads this."
              aria-label="Rejection reason"
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={gateBusy !== null}
              onClick={() =>
                void decideGate(rejectingPhase, false, rejectReason.trim() || undefined)
              }
            >
              Confirm rejection
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setRejectingPhase(null)}>
              Cancel
            </button>
          </div>
        ) : null}
      </section>

      <section className="film-chat" aria-label="Studio chat">
        <div className="film-chat-thread">
          {messages.length === 0 ? (
            <p className="film-chat-empty">
              Talk to the studio crew: give the brief, then ask for the bible, the asset pack, the
              shotlist, and the storyboard.
            </p>
          ) : (
            messages.map((message, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only thread without ids
                key={`${index}-${message.role}`}
                className="film-chat-message"
                data-role={message.role}
              >
                {message.content}
              </div>
            ))
          )}
          {turnBusy ? (
            <div className="film-chat-message" data-role="assistant">
              <Spinner aria-label="The studio is working" />
              <span className="film-chat-activity">{turnActivity ?? "Thinking..."}</span>
              {crew.length > 0 ? (
                <ul className="film-crew" aria-label="Departments on the job">
                  {crew.map((step) => (
                    <li
                      key={step.key}
                      className="film-crew-chip"
                      data-state={step.done ? (step.failed ? "failed" : "done") : "working"}
                    >
                      {step.label}
                      {step.done && !step.failed && typeof step.costDiem === "number"
                        ? ` (${step.costDiem.toFixed(2)} DIEM)`
                        : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div ref={chatEndRef} />
        </div>
        {improvedDraft ? (
          <div className="film-brief-preview">
            <p className="film-brief-preview-title">Improved message</p>
            <pre className="film-brief-preview-text">{improvedDraft}</pre>
            <div className="studio-card-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setDraft(improvedDraft);
                  setImprovedDraft(null);
                }}
              >
                Use this message
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setImprovedDraft(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {pendingAttach ? (
          <div className="film-ref-card">
            <img
              src={pendingAttach.previewDataUri}
              alt={pendingAttach.fileName}
              className="film-ref-thumb"
            />
            <div className="film-ref-meta">
              <PillGroup
                options={FILM_REF_ROLES.map((role) => ({
                  value: role,
                  label: FILM_REF_ROLE_LABELS[role],
                }))}
                value={pendingAttach.role}
                onChange={(role) =>
                  setPendingAttach((current) => (current ? { ...current, role } : current))
                }
                ariaLabel="Reference role"
              />
              <input
                className="studio-input"
                type="text"
                value={pendingAttach.label}
                placeholder="Name it for the crew (optional)"
                aria-label="Reference name"
                onChange={(event) =>
                  setPendingAttach((current) =>
                    current ? { ...current, label: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="studio-card-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={attachBusy}
                onClick={() => void confirmAttachment()}
              >
                {attachBusy ? "Uploading..." : "Add to message"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={attachBusy}
                onClick={() => setPendingAttach(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <div className="film-chat-composer">
          <textarea
            className="studio-textarea"
            rows={2}
            value={draft}
            placeholder="Message the studio crew"
            aria-label="Message the studio crew"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={attachBusy || turnBusy || pendingAttach !== null}
            onClick={() => attachInputRef.current?.click()}
          >
            Attach image
          </button>
          <input
            ref={attachInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              void pickAttachment(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!draft.trim() || improving || turnBusy}
            onClick={() => void improveDraft()}
          >
            {improving ? "Improving..." : "Improve with AI"}
          </button>
          <button
            type="button"
            className="studio-primary-button"
            disabled={!draft.trim() || turnBusy}
            onClick={() => void sendMessage()}
          >
            Send
          </button>
        </div>
      </section>

      <section className="film-produce" aria-label="Production">
        <FilmProduceControl
          slug={slug}
          onStarted={() => void refresh()}
          onError={(message) => setError(message)}
        />
      </section>

      {status?.review ? (
        <section className="film-review" aria-label="Film review">
          <h4 className="film-review-title">The studio's review of the cut</h4>
          <p className="film-review-scores">
            {[
              ["Story", status.review.narrativeClarity],
              ["Pacing", status.review.pacing],
              ["Look", status.review.visualIdentity],
              ["Payoff", status.review.emotionalPayoff],
            ]
              .filter(([, value]) => typeof value === "number")
              .map(([label, value]) => `${label} ${value}/10`)
              .join(" - ")}
            {typeof status.review.aiTellScore === "number"
              ? ` - reads as AI ${status.review.aiTellScore}/10 (lower is better)`
              : ""}
          </p>
          {status.review.notes ? <p className="film-review-notes">{status.review.notes}</p> : null}
          {status.review.weakestShots.length > 0 ? (
            <div className="film-review-weakest">
              <p className="film-review-weakest-title">Rework these first:</p>
              <div className="studio-card-actions">
                {status.review.weakestShots.map((shotId) => (
                  <button
                    key={shotId}
                    type="button"
                    className="btn btn-secondary"
                    disabled={shotBusy === shotId}
                    onClick={() =>
                      void shotAction(shotId, () => videomakerShotRetake(slug, shotId))
                    }
                  >
                    {shotBusy === shotId ? `Retaking ${shotId}...` : `Retake ${shotId}`}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {board && board.scenes.length > 0 ? (
        <section className="film-board" aria-label="Shot board">
          <p className="film-board-totals">
            {board.totals.shotsDone}/{board.totals.shotsTotal} shots done -{" "}
            {board.totals.spentDiem.toLocaleString(undefined, { maximumFractionDigits: 1 })} DIEM
            spent
            {board.totals.etaSeconds
              ? ` - ~${Math.ceil(board.totals.etaSeconds / 60)} min left`
              : ""}
          </p>
          {board.scenes.map((scene) => (
            <div key={scene.sceneId} className="film-scene">
              <h4 className="film-scene-title">{scene.title}</h4>
              <ul className="film-shot-list">
                {scene.shots.map((shot) => {
                  const busy = shotBusy === shot.shotId;
                  const takes = takesByShot[shot.shotId] ?? [];
                  const open = openShot === shot.shotId;
                  return (
                    <li key={shot.shotId} className="film-shot" data-status={shot.status}>
                      <button
                        type="button"
                        className="film-shot-summary"
                        onClick={() => void toggleShot(shot.shotId)}
                      >
                        {shot.frameUrl ? (
                          <img className="film-shot-frame" src={shot.frameUrl} alt="" />
                        ) : null}
                        <span className="film-shot-id">{shot.shotId}</span>
                        <span className="film-shot-status">
                          {shot.status}
                          {shot.toReview ? " - to review" : ""}
                          {shot.takes > 1 ? ` - ${shot.takes} takes` : ""}
                        </span>
                      </button>
                      {open ? (
                        <div className="film-shot-detail">
                          {shot.clipUrl ? (
                            // biome-ignore lint/a11y/useMediaCaption: generated video has no track
                            <video
                              className="studio-video-player"
                              src={shot.clipUrl}
                              controls
                              preload="metadata"
                            />
                          ) : null}
                          {shot.error ? <p className="studio-error">{shot.error}</p> : null}
                          {takes.length > 1 ? (
                            <div className="film-takes">
                              {takes.map((take) => (
                                <button
                                  key={take.version}
                                  type="button"
                                  className="studio-pill"
                                  data-active={take.isCurrent}
                                  disabled={busy || take.isCurrent}
                                  onClick={() =>
                                    void shotAction(shot.shotId, () =>
                                      videomakerTakeSelect(slug, shot.shotId, take.version),
                                    )
                                  }
                                >
                                  Take {take.version}
                                  {take.isCurrent ? " (current)" : ""}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="film-shot-actions">
                            <input
                              className="studio-input"
                              type="text"
                              value={retakePrompt}
                              placeholder="Optional adjusted prompt for the retake"
                              aria-label="Retake prompt"
                              onChange={(event) => setRetakePrompt(event.target.value)}
                            />
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busy}
                              onClick={() =>
                                void shotAction(shot.shotId, () =>
                                  videomakerShotRetake(
                                    slug,
                                    shot.shotId,
                                    retakePrompt.trim() || undefined,
                                  ),
                                )
                              }
                            >
                              Retake
                            </button>
                            {shot.status === "failed" ? (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={busy}
                                onClick={() =>
                                  void shotAction(shot.shotId, () =>
                                    videomakerShotRequeue(slug, shot.shotId),
                                  )
                                }
                              >
                                Retry
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={busy}
                              onClick={() =>
                                void shotAction(shot.shotId, () =>
                                  videomakerShotSkip(slug, shot.shotId),
                                )
                              }
                            >
                              Skip shot
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
