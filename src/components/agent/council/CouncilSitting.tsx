import { listen } from "@tauri-apps/api/event";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleDashed } from "central-icons/IconCircleDashed";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { textPricing, type TextPrice } from "../../../lib/carpe-diem-text-pricing";
import {
  awaitsUser,
  baselineDrafts,
  wasContested,
  councilAnswerQuestions,
  councilBindSession,
  councilConvene,
  councilCycle as fetchCycle,
  councilDrafts as fetchDrafts,
  councilForget,
  councilPlan,
  councilUpdateMandate,
  COUNCIL_EVENT,
  EMPTY_MANDATE,
  isSitting,
  mandateProblems,
  pendingSeats,
  type CouncilCycle,
  type CouncilQuestion,
  estimateSittingCost,
  formatSittingCost,
  type CouncilSeat,
  type Mandate,
  type SeatDraft,
  type SittingPlan,
} from "../../../lib/council";
import { MandateEditor } from "./MandateEditor";

/**
 * The sitting, from the request to the moment the agent takes over (ADR-0034).
 *
 * It takes over the main region rather than opening a window, because this is
 * where a new session already begins: a council is a richer way to start one,
 * not a second place to be.
 *
 * The row is the source of truth throughout. Progress arrives on
 * {@link COUNCIL_EVENT}, so closing this and coming back mid-sitting shows
 * exactly where it got to, and a reload does not lose a deliberation that has
 * already been paid for.
 */
export function CouncilSitting({
  request,
  mandateId,
  workingDir,
  unrestricted,
  onConvened,
  onHandOff,
  onClose,
}: {
  request: string;
  /** Null until the user has agreed to convene. Nothing is spent before that. */
  mandateId: string | null;
  workingDir?: string;
  unrestricted?: boolean;
  onConvened: (mandateId: string) => void;
  /** Creates the session with the rendered mandate and returns its stored id.
   * The council does not know how a session is made; it knows what to say. */
  onHandOff: (prompt: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [cycle, setCycle] = useState<CouncilCycle | null>(null);
  const [drafts, setDrafts] = useState<SeatDraft[]>([]);
  const [edited, setEdited] = useState<Mandate | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBaseline, setShowBaseline] = useState(false);
  const handedOff = useRef(false);

  // One subscription drives both reads. Drafts are re-fetched from inside the
  // event handler rather than from an effect keyed on a counter: the event IS
  // the signal that a seat landed, and routing it through a dependency array
  // would only be a longer way of saying so.
  const [plan, setPlan] = useState<SittingPlan | null>(null);
  const [prices, setPrices] = useState<TextPrice[]>([]);

  // The plan is read before anything is spent: who would sit, on which models,
  // on what ground, and what the range would cost. This is the same handshake
  // the Studio's run button makes -- the figure shown is the figure it costs,
  // and nothing starts without a tap.
  useEffect(() => {
    if (mandateId) return;
    let live = true;
    void councilPlan({ request, workingDir, unrestricted })
      .then((next) => {
        if (live) setPlan(next);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    void textPricing().then((table) => {
      if (live) setPrices(table);
    });
    return () => {
      live = false;
    };
  }, [mandateId, request, workingDir, unrestricted]);

  useEffect(() => {
    if (!mandateId) return;
    let live = true;
    const readDrafts = (round: number) => {
      void fetchDrafts(mandateId, round)
        .then((rows) => {
          if (live) setDrafts(rows);
        })
        .catch(() => {
          // Drafts are the transparency, not the mechanism. Failing to read
          // them must never take the sitting down.
        });
    };
    void fetchCycle(mandateId).then((row) => {
      if (!live || !row) return;
      setCycle(row);
      readDrafts(row.round);
    });
    const unlisten = listen<CouncilCycle>(COUNCIL_EVENT, (event) => {
      if (event.payload.id !== mandateId) return;
      setCycle(event.payload);
      readDrafts(event.payload.round);
    });
    return () => {
      live = false;
      void unlisten.then((off) => off());
    };
  }, [mandateId]);

  // The issued mandate seeds the editor once, and the user's edits win from
  // then on: re-seeding on every event would erase what they are typing.
  const issuedAt = cycle?.status === "ready" ? cycle.updatedAt : null;
  useEffect(() => {
    if (!issuedAt) return;
    setEdited(null);
  }, [issuedAt]);

  const mandate = edited ?? cycle?.mandate ?? EMPTY_MANDATE;
  const problems = useMemo(
    () => (cycle?.status === "ready" ? mandateProblems(mandate) : []),
    [cycle?.status, mandate],
  );

  const handOff = useCallback(async () => {
    if (!cycle || !mandateId || handedOff.current) return;
    setBusy(true);
    setError(null);
    try {
      let current = cycle;
      // Unsaved edits are saved first, and the prompt is taken from what comes
      // back: handing over a string this component composed would be the one
      // thing the whole design forbids.
      if (edited) {
        current = await councilUpdateMandate(mandateId, edited);
        setCycle(current);
        setEdited(null);
      }
      const prompt = current.renderedPrompt;
      if (!prompt) {
        setError("This mandate has no rendered instructions yet.");
        return;
      }
      handedOff.current = true;
      const sessionId = await onHandOff(prompt);
      if (!sessionId) {
        handedOff.current = false;
        setError("The session could not be started, so the mandate was not handed over.");
        return;
      }
      await councilBindSession({
        mandateId,
        sessionId,
        workingDir: current.workingDir ?? undefined,
      });
      onClose();
    } catch (err) {
      handedOff.current = false;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [cycle, edited, mandateId, onClose, onHandOff]);

  const sendAnswers = useCallback(
    async (skip: boolean) => {
      if (!cycle || !mandateId) return;
      setBusy(true);
      setError(null);
      try {
        const payload: CouncilQuestion[] = cycle.questions.map((question) => ({
          ...question,
          answer: skip ? null : (answers[question.id] ?? null),
        }));
        setCycle(await councilAnswerQuestions(mandateId, payload));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [answers, cycle, mandateId],
  );

  const convene = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const opened = await councilConvene({ request, workingDir, unrestricted });
      onConvened(opened.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onConvened, request, unrestricted, workingDir]);

  const dismiss = useCallback(async () => {
    // Deleting the row is the cancel: a sitting in flight notices between
    // movements and stands down rather than finishing work nobody wants.
    if (mandateId) {
      try {
        await councilForget(mandateId);
      } catch {
        // Already gone, which is the same outcome.
      }
    }
    onClose();
  }, [mandateId, onClose]);

  if (!mandateId) {
    return (
      <CouncilProposal
        request={request}
        plan={plan}
        prices={prices}
        busy={busy}
        error={error}
        onConvene={convene}
        onClose={onClose}
      />
    );
  }

  if (!cycle) {
    return (
      <section className="council-sitting" aria-label="Council">
        <p className="council-status">Convening…</p>
      </section>
    );
  }

  const waiting = pendingSeats(cycle, drafts);
  const baseline = baselineDrafts(drafts);

  return (
    <section className="council-sitting" aria-label="Council">
      <header className="council-header">
        <div className="council-header-text">
          <h2 className="council-title">The council</h2>
          <p className="council-request">{cycle.request}</p>
        </div>
        <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss">
          <IconCrossSmall size={16} aria-hidden />
        </button>
      </header>

      <ol className="council-seats">
        {cycle.seats.map((seat) => (
          <SeatRow
            key={seat.id}
            seat={seat}
            state={seatState(seat, drafts, waiting, cycle.status)}
          />
        ))}
      </ol>

      {cycle.status === "deliberating" ? (
        <p className="council-status" role="status">
          {waiting.length > 0
            ? `Reading it independently. ${waiting.length} of ${
                cycle.seats.filter((seat) => seat.role === "position").length
              } still to answer. They run at once, so the round takes as long as the slowest of them.`
            : "Merging what they said."}
        </p>
      ) : null}

      {cycle.status === "questions" ? (
        <div className="council-questions">
          <p className="council-status">
            More than one seat needed the same thing settled before drafting. Nothing else is asked.
          </p>
          {cycle.questions.map((question) => (
            // A wrapping label would fold the "raised by" line into the field's
            // accessible name, so a screen reader would announce the question
            // and the provenance as one sentence. The question alone is the
            // label; the provenance is a sibling.
            <div className="council-field" key={question.id}>
              <label className="council-field-label" htmlFor={`council-q-${question.id}`}>
                {question.question}
              </label>
              <p className="council-field-hint">Raised by {question.raisedBy} seats</p>
              <input
                id={`council-q-${question.id}`}
                className="council-input"
                value={answers[question.id] ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                }
              />
            </div>
          ))}
          <div className="council-actions">
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void sendAnswers(false)}
            >
              Send answers
            </button>
            <button
              type="button"
              className="council-secondary"
              disabled={busy}
              onClick={() => void sendAnswers(true)}
            >
              Skip, decide for me
            </button>
          </div>
        </div>
      ) : null}

      {cycle.status === "ready" ? (
        <>
          {!wasContested(drafts) ? (
            // The objection seat is the one that stops the table agreeing with
            // itself. Losing it still produces a mandate, and the seat row
            // already carries its X -- but this is the moment somebody decides
            // to hand the thing over, and it is the moment worth saying it at.
            <div className="council-notice" role="status">
              <h3 className="council-notice-title">Nobody attacked this mandate</h3>
              <p>
                The objection seat did not answer, so what you are about to hand over is what the
                other seats agreed on, unchallenged.
              </p>
            </div>
          ) : null}
          {cycle.dissent.length > 0 ? (
            <div className="council-notice council-dissent">
              <h3 className="council-notice-title">Where they disagreed</h3>
              <ul>
                {cycle.dissent.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {cycle.cuts.length > 0 ? (
            <div className="council-notice council-cuts">
              <h3 className="council-notice-title">What was cut to fit</h3>
              <ul>
                {cycle.cuts.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <MandateEditor mandate={mandate} disabled={busy} onChange={(next) => setEdited(next)} />

          {problems.length > 0 ? (
            <ul className="council-problems" role="alert">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}

          <div className="council-actions">
            <button
              type="button"
              className="primary-action"
              disabled={busy || problems.length > 0}
              onClick={() => void handOff()}
            >
              Hand to the agent
            </button>
            <button type="button" className="council-secondary" onClick={dismiss}>
              Discard
            </button>
          </div>
        </>
      ) : null}

      {cycle.status === "failed" ? (
        <div className="council-notice council-failed" role="alert">
          <h3 className="council-notice-title">The sitting stopped</h3>
          <p>{cycle.lastError ?? "Something went wrong."}</p>
        </div>
      ) : null}

      {baseline.length > 0 ? (
        <div className="council-baseline">
          <button
            type="button"
            className="council-secondary"
            onClick={() => setShowBaseline((open) => !open)}
            aria-expanded={showBaseline}
          >
            {showBaseline ? "Hide" : "Show"} what each model said alone
          </button>
          {showBaseline ? (
            <div className="council-baseline-body">
              <p className="council-field-hint">
                One independent answer per model, written before any of them saw the others. It is
                also what a single model would have produced on its own, which is the thing the
                council is worth comparing against.
              </p>
              {baseline.map((draft) => (
                <article className="council-draft" key={`${draft.seatId}-${draft.createdAt}`}>
                  <h4 className="council-draft-title">
                    {seatName(cycle.seats, draft.seatId)}
                    <span className="council-draft-model">{draft.model}</span>
                  </h4>
                  <p className="council-draft-objective">{draft.mandate?.objective}</p>
                  {draft.mandate?.acceptance.length ? (
                    <ul className="council-draft-list">
                      {draft.mandate.acceptance.map((criterion) => (
                        <li key={criterion.statement}>{criterion.statement}</li>
                      ))}
                    </ul>
                  ) : null}
                  {draft.whatWouldChangeMyMind ? (
                    <p className="council-draft-mind">
                      Would change its mind if: {draft.whatWouldChangeMyMind}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="council-footer">
        <span>
          {cycle.modelCalls} model {cycle.modelCalls === 1 ? "call" : "calls"} so far
        </span>
        {isSitting(cycle) ? <span>Working</span> : null}
        {awaitsUser(cycle) ? <span>Waiting on you</span> : null}
      </footer>

      {error ? (
        <p className="council-problems" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * What convening would cost, before it is convened.
 *
 * The range is honest rather than reassuring: the low end is a council that
 * agrees and draws no objection, the high end is one that has to ask something
 * and then answer an objection. Both are reachable, and the user is the person
 * deciding whether to buy either.
 */
function CouncilProposal({
  request,
  plan,
  prices,
  busy,
  error,
  onConvene,
  onClose,
}: {
  request: string;
  plan: SittingPlan | null;
  prices: TextPrice[];
  busy: boolean;
  error: string | null;
  onConvene: () => void;
  onClose: () => void;
}) {
  const cost = plan ? formatSittingCost(estimateSittingCost(plan, prices)) : undefined;
  return (
    <section className="council-sitting" aria-label="Council">
      <header className="council-header">
        <div className="council-header-text">
          <h2 className="council-title">Put this to the council</h2>
          <p className="council-request">{request}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Dismiss">
          <IconCrossSmall size={16} aria-hidden />
        </button>
      </header>

      {plan ? (
        <>
          <p className="council-status">
            Each seat reads your request alone, on a different model, and writes what it thinks the
            agent should be asked to do. The chair merges them into a mandate you can edit before
            anything runs.
          </p>
          <ol className="council-seats">
            {plan.seats.map((seat) => (
              <SeatRow key={seat.id} seat={seat} state="idle" />
            ))}
          </ol>
          {!plan.situation?.trim() ? (
            // The single line that would have saved a real sitting: no folder
            // means the deliverable is the reply, so the seats are told to
            // write criteria a reader can settle, and the verdict reads that
            // reply instead of finding nothing and calling everything
            // unverifiable.
            <div className="council-notice" role="status">
              <h3 className="council-notice-title">No working folder</h3>
              <p>
                The agent will answer in the conversation rather than change files, so the mandate
                will only ask for what can be settled by reading that answer, and the reading at the
                end will judge the answer itself.
              </p>
            </div>
          ) : null}
          {plan.reusedFamilies.length > 0 ? (
            <div className="council-notice">
              <h3 className="council-notice-title">Two seats are sharing weights</h3>
              <p>
                The catalog offered fewer model families than there are seats, so this council is
                less independent than it looks.
              </p>
            </div>
          ) : null}
          <dl className="council-plan">
            <div>
              <dt>Model calls</dt>
              <dd>
                {plan.minModelCalls} to {plan.maxModelCalls}
                {/* A seat that answers with nothing is asked once more, which
                    is a billed call the range above does not contain. Saying
                    so is cheaper than inflating every estimate to cover a
                    failure that is rare. */}
                <span className="council-plan-note">, plus one if a seat comes back empty</span>
              </dd>
            </div>
            {cost ? (
              <div>
                <dt>Estimated cost</dt>
                <dd>{cost}</dd>
              </div>
            ) : null}
            {plan.situation ? (
              <div>
                <dt>Ground</dt>
                <dd className="council-plan-situation">{plan.situation}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="council-status">Reading the ground…</p>
      )}

      {error ? (
        <p className="council-problems" role="alert">
          {error}
        </p>
      ) : null}

      <div className="council-actions">
        <button
          type="button"
          className="primary-action"
          disabled={busy || !plan}
          onClick={onConvene}
        >
          Convene
        </button>
        <button type="button" className="council-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

type SeatState = "waiting" | "spoke" | "failed" | "idle";

function seatState(
  seat: CouncilSeat,
  drafts: SeatDraft[],
  waiting: CouncilSeat[],
  status: CouncilCycle["status"],
): SeatState {
  const own = drafts.filter((draft) => draft.seatId === seat.id);
  if (own.some((draft) => !draft.failed)) return "spoke";
  if (own.length > 0) return "failed";
  if (seat.role === "position" && waiting.some((entry) => entry.id === seat.id)) {
    return status === "deliberating" ? "waiting" : "idle";
  }
  return "idle";
}

function SeatRow({ seat, state }: { seat: CouncilSeat; state: SeatState }) {
  return (
    <li className="council-seat" data-state={state}>
      <SeatIcon state={state} />
      <span className="council-seat-text">
        <span className="council-seat-name">{seat.name}</span>
        <span className="council-seat-charge">{seat.charge}</span>
      </span>
      <span className="council-seat-model" title={seat.model}>
        {seat.modelFamily}
      </span>
    </li>
  );
}

function SeatIcon({ state }: { state: SeatState }) {
  if (state === "spoke") return <IconCircleCheck size={16} aria-hidden />;
  if (state === "failed") return <IconCircleX size={16} aria-hidden />;
  if (state === "waiting") return <IconCircleQuestionmark size={16} aria-hidden />;
  return <IconCircleDashed size={16} aria-hidden />;
}

function seatName(seats: CouncilSeat[], seatId: string): string {
  return seats.find((seat) => seat.id === seatId)?.name ?? seatId;
}
