import { t } from "../../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  councilCycles,
  councilPlan,
  councilSeatModels,
  councilVerdicts,
  requestExcerpt,
  setCouncilSeatModel,
  verdictTally,
  type CouncilCycle,
  type CouncilSeatModels,
  type CouncilVerdict,
  type SittingPlan,
} from "../../lib/council";
import { listVeniceModels, type VeniceModelDto } from "../../lib/tauri";

/**
 * Settings › Council (ADR-0034).
 *
 * Three things, and deliberately not a builder. The councils themselves are
 * built in: a screen offering twenty of them is a screen nobody reads. What
 * each seat runs on is not built in, because someone who knows that one model
 * argues well and another flatters should be able to say so. Pinning is per
 * seat and optional; anything left alone is assigned automatically, so this
 * stays a page you can ignore.
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
  const [pins, setPins] = useState<CouncilSeatModels>({ seats: {} });
  const [models, setModels] = useState<VeniceModelDto[]>([]);

  /** Both rosters are re-read after a pin: changing one seat can move another,
   * because the automatic assignment fills around what is now taken. */
  const reloadPlans = useCallback(async () => {
    const [mandate, verdict] = await Promise.all([
      councilPlan({ request: "" }),
      councilPlan({ request: "", councilId: "verdict" }),
    ]);
    setPlan(mandate);
    setVerdictPlan(verdict);
  }, []);

  const pinSeat = useCallback(
    async (seatId: string, model: string) => {
      setPins(await setCouncilSeatModel(seatId, model));
      await reloadPlans();
    },
    [reloadPlans],
  );

  useEffect(() => {
    let live = true;
    void councilPlan({ request: "" }).then((next) => {
      if (live) setPlan(next);
    });
    void councilPlan({ request: "", councilId: "verdict" }).then((next) => {
      if (live) setVerdictPlan(next);
    });
    void councilSeatModels().then((next) => {
      if (live) setPins(next);
    });
    // The catalog the seats can actually be pointed at. Best-effort: without
    // it the rows still show what each seat runs on, they just cannot be
    // changed, which is exactly how this screen behaved before.
    void listVeniceModels("generation").then(
      (response) => {
        if (live) setModels(response.models ?? []);
      },
      () => {},
    );
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
        {t("Council")}
      </h2>
      <p className="settings-group-description">
        {t("Type")} <code>/council</code>{" "}
        {t(
          "in the chat to put a request to several models before any work starts. They read it independently, on different weights, and issue a mandate you can edit. When the work is done they read it back against that mandate.",
        )}
      </p>

      <Roster
        title={t("Issuing a mandate")}
        plan={plan}
        pins={pins}
        models={models}
        onPin={pinSeat}
      />
      <Roster
        title={t("Judging finished work")}
        plan={verdictPlan}
        pins={pins}
        models={models}
        onPin={pinSeat}
        note={t(
          "These never run on the model the work was written on. A reviewer sharing weights with the author shares its blind spots, so a seat pinned to that model is passed over for that sitting.",
        )}
      />

      <div className="settings-card">
        <h3 className="settings-row-title">{t("Recent sittings")}</h3>
        {cycles.length === 0 ? (
          <p className="settings-group-description">
            {t("Nothing has been put to the council yet.")}
          </p>
        ) : (
          <ul className="council-history">
            {cycles.map((cycle) => {
              const latest = verdicts[cycle.id]?.at(-1);
              const tally = latest ? verdictTally(latest) : null;
              return (
                <li key={cycle.id}>
                  <span className="council-history-request" title={cycle.request}>
                    {requestExcerpt(cycle.request, 120)}
                  </span>
                  <span className="council-history-meta">
                    {t("{count} model calls", { count: cycle.modelCalls })}
                    {tally
                      ? ` · ${t("{satisfied} of {total} criteria held", { satisfied: tally.satisfied, total: tally.total })}`
                      : ""}
                    {cycle.round > 0
                      ? ` · ${t("{count} correction(s)", { count: cycle.round })}`
                      : ""}
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

function Roster({
  title,
  plan,
  pins,
  models,
  note,
  onPin,
}: {
  title: string;
  plan: SittingPlan | null;
  pins: CouncilSeatModels;
  models: VeniceModelDto[];
  note?: string;
  onPin: (seatId: string, model: string) => Promise<void>;
}) {
  return (
    <div className="settings-card">
      <h3 className="settings-row-title">{title}</h3>
      {note ? <p className="settings-group-description">{note}</p> : null}
      {plan ? (
        <>
          <ul className="council-seats">
            {plan.seats.map((seat) => {
              const pinned = pins.seats[seat.id] ?? "";
              return (
                <li className="council-seat" key={seat.id} data-state="idle">
                  <span className="council-seat-text">
                    <span className="council-seat-name">{seat.name}</span>
                    <span className="council-seat-charge">{seat.charge}</span>
                  </span>
                  {models.length > 0 ? (
                    <select
                      className="council-seat-picker"
                      aria-label={t("Model for {name}", { name: seat.name })}
                      value={pinned}
                      onChange={(event) => void onPin(seat.id, event.target.value)}
                    >
                      {/* Left alone by default, and named by what it does
                          rather than by the absence of a choice. */}
                      <option value="">
                        {t("Chosen for me ({model})", { model: seat.model })}
                      </option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="council-seat-model" title={seat.model}>
                      {seat.model}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {plan.reusedFamilies.length > 0 ? (
            <p className="settings-group-description">
              {plan.reusedByChoice
                ? t(
                    "Two of these seats are pinned to the same model family, so they will tend to agree. A council is only worth its cost when its seats can disagree.",
                  )
                : t(
                    "The catalog offers fewer model families than there are seats, so some of them are sharing weights. This council is less independent than it looks.",
                  )}
            </p>
          ) : null}
        </>
      ) : (
        <p className="settings-group-description">{t("Reading the model catalog…")}</p>
      )}
    </div>
  );
}
