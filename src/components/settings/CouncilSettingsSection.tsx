import { useEffect, useState } from "react";
import {
  councilCycles,
  councilPlan,
  councilVerdicts,
  verdictTally,
  type CouncilCycle,
  type CouncilVerdict,
  type SittingPlan,
} from "../../lib/council";

/**
 * Settings › Council (ADR-0034).
 *
 * Two things, and deliberately not a builder. The councils are built in: a
 * screen offering twenty of them is a screen nobody reads, and a seat is only
 * worth what its model can see, which is not something a text field improves.
 *
 * The second half is the part that earns the feature its keep. Every sitting's
 * blind round is one independent answer per model family, which is exactly
 * what a single model would have produced alone. Listing the cycles next to
 * what their verdicts found is how someone discovers, over twenty of them,
 * whether the council is worth its surcharge — and no other multi-model
 * product can show that, because none of them keeps the uncontaminated first
 * answer.
 */
export function CouncilSettingsSection() {
  const [plan, setPlan] = useState<SittingPlan | null>(null);
  const [verdictPlan, setVerdictPlan] = useState<SittingPlan | null>(null);
  const [cycles, setCycles] = useState<CouncilCycle[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, CouncilVerdict[]>>({});

  useEffect(() => {
    let live = true;
    void councilPlan({ request: "" }).then((next) => {
      if (live) setPlan(next);
    });
    void councilPlan({ request: "", councilId: "verdict" }).then((next) => {
      if (live) setVerdictPlan(next);
    });
    void councilCycles(20).then(async (rows) => {
      if (!live) return;
      setCycles(rows);
      const settled = await Promise.all(
        rows.map(async (cycle) => [cycle.id, await councilVerdicts(cycle.id)] as const),
      );
      if (live) setVerdicts(Object.fromEntries(settled));
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="settings-group" aria-labelledby="council-heading">
      <h2 id="council-heading" className="settings-group-heading">
        Council
      </h2>
      <p className="settings-group-description">
        Type <code>/council</code> in the chat to put a request to several models before any work
        starts. They read it independently, on different weights, and issue a mandate you can edit.
        When the work is done they read it back against that mandate.
      </p>

      <Roster title="Issuing a mandate" plan={plan} />
      <Roster
        title="Judging finished work"
        plan={verdictPlan}
        note="These never run on the model the work was written on. A reviewer sharing weights with the author shares its blind spots."
      />

      <div className="settings-card">
        <h3 className="settings-row-title">Recent sittings</h3>
        {cycles.length === 0 ? (
          <p className="settings-group-description">Nothing has been put to the council yet.</p>
        ) : (
          <ul className="council-history">
            {cycles.map((cycle) => {
              const latest = verdicts[cycle.id]?.at(-1);
              const tally = latest ? verdictTally(latest) : null;
              return (
                <li key={cycle.id}>
                  <span className="council-history-request">{cycle.request}</span>
                  <span className="council-history-meta">
                    {cycle.modelCalls} model calls
                    {tally ? ` · ${tally.satisfied} of ${tally.total} criteria held` : ""}
                    {cycle.round > 0 ? ` · ${cycle.round} correction(s)` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function Roster({ title, plan, note }: { title: string; plan: SittingPlan | null; note?: string }) {
  return (
    <div className="settings-card">
      <h3 className="settings-row-title">{title}</h3>
      {note ? <p className="settings-group-description">{note}</p> : null}
      {plan ? (
        <>
          <ul className="council-seats">
            {plan.seats.map((seat) => (
              <li className="council-seat" key={seat.id} data-state="idle">
                <span className="council-seat-text">
                  <span className="council-seat-name">{seat.name}</span>
                  <span className="council-seat-charge">{seat.charge}</span>
                </span>
                <span className="council-seat-model" title={seat.model}>
                  {seat.model}
                </span>
              </li>
            ))}
          </ul>
          {plan.reusedFamilies.length > 0 ? (
            <p className="settings-group-description">
              The catalog offers fewer model families than there are seats, so some of them are
              sharing weights. This council is less independent than it looks.
            </p>
          ) : null}
        </>
      ) : (
        <p className="settings-group-description">Reading the model catalog…</p>
      )}
    </div>
  );
}
