import { useEffect, useId, useState } from "react";
import {
  type Assignment,
  type AssignmentInput,
  type Autonomy,
  type Cadence,
  assignmentSave,
  minuteFromTime,
  timeFromMinute,
  toolChoices,
  weekdayName,
} from "../../lib/assignments";
import { type ErrandTarget, errandTargets } from "../../lib/errands";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";

const CADENCES: Cadence[] = ["daily", "weekdays", "weekly", "hourly", "every"];

function cadenceName(cadence: Cadence): string {
  switch (cadence) {
    case "hourly":
      return t("Every hour");
    case "daily":
      return t("Every day");
    case "weekdays":
      return t("Weekdays");
    case "weekly":
      return t("Every week");
    case "every":
      return t("Every few hours");
  }
}

/**
 * The form for an assignment or a scheduled task. Both shells use it; the
 * phone also picks which device runs it, since a computer can run what the
 * phone set up (an errand, ADR-0054 and ADR-0091).
 */
export function AssignmentEditor({
  initial,
  platform,
  onSaved,
  onCancel,
}: {
  initial: AssignmentInput;
  platform: "desktop" | "phone";
  onSaved: (assignment: Assignment) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AssignmentInput>(initial);
  const [targets, setTargets] = useState<ErrandTarget[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    title: useId(),
    goal: useId(),
    cadence: useId(),
    time: useId(),
    weekday: useId(),
    hours: useId(),
    device: useId(),
  };
  const isTask = draft.kind === "task";

  useEffect(() => {
    if (platform !== "phone") return;
    void errandTargets().then(setTargets);
  }, [platform]);

  const update = (patch: Partial<AssignmentInput>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const toggleTool = (id: string) =>
    update({
      tools: draft.tools.includes(id)
        ? draft.tools.filter((tool) => tool !== id)
        : [...draft.tools, id],
    });

  async function save() {
    setSaving(true);
    try {
      onSaved(await assignmentSave(draft));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  const choices = toolChoices(platform);
  return (
    <form
      className="assignment-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="assignment-field-label" htmlFor={ids.goal}>
        {isTask ? t("What should it do?") : t("What should the assistant work on?")}
      </label>
      <textarea
        id={ids.goal}
        className="assignment-textarea"
        rows={4}
        required
        value={draft.goal}
        placeholder={
          isTask
            ? t("Summarize the news about my sector")
            : t(
                "Watch public tenders in Geneva that match my company, and draft a short reply for each",
              )
        }
        onChange={(event) => update({ goal: event.target.value })}
      />
      <label className="assignment-field-label" htmlFor={ids.title}>
        {t("Name")}
      </label>
      <input
        id={ids.title}
        className="assignment-input"
        value={draft.title}
        placeholder={t("Optional, taken from the goal otherwise")}
        onChange={(event) => update({ title: event.target.value })}
      />

      <fieldset className="assignment-fieldset">
        <legend className="assignment-field-label">{t("When")}</legend>
        <div className="assignment-row">
          <select
            id={ids.cadence}
            aria-label={t("How often")}
            className="assignment-input"
            value={draft.cadence}
            onChange={(event) => update({ cadence: event.target.value as Cadence })}
          >
            {CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {cadenceName(cadence)}
              </option>
            ))}
          </select>
          {draft.cadence === "weekly" ? (
            <select
              id={ids.weekday}
              aria-label={t("Day")}
              className="assignment-input"
              value={draft.weekday}
              onChange={(event) => update({ weekday: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <option key={day} value={day}>
                  {weekdayName(day)}
                </option>
              ))}
            </select>
          ) : null}
          {draft.cadence === "every" ? (
            <select
              id={ids.hours}
              aria-label={t("Hours between runs")}
              className="assignment-input"
              value={draft.everyHours}
              onChange={(event) => update({ everyHours: Number(event.target.value) })}
            >
              {[2, 3, 4, 6, 8, 12].map((hours) => (
                <option key={hours} value={hours}>
                  {t("Every {hours} hours", { hours })}
                </option>
              ))}
            </select>
          ) : null}
          <input
            id={ids.time}
            type="time"
            aria-label={draft.cadence === "hourly" ? t("Minute of the hour") : t("Time")}
            className="assignment-input"
            value={timeFromMinute(draft.atMinute)}
            onChange={(event) => {
              const minute = minuteFromTime(event.target.value);
              if (minute !== null) update({ atMinute: minute });
            }}
          />
        </div>
      </fieldset>

      <fieldset className="assignment-fieldset">
        <legend className="assignment-field-label">{t("Autonomy")}</legend>
        {(["ask", "act"] as Autonomy[]).map((autonomy) => (
          <label key={autonomy} className="assignment-choice">
            <input
              type="radio"
              name="assignment-autonomy"
              checked={draft.autonomy === autonomy}
              onChange={() => update({ autonomy })}
            />
            <span>
              <span className="assignment-choice-title">
                {autonomy === "ask"
                  ? t("Ask before anything leaves the device")
                  : t("Act within these tools")}
              </span>
              <span className="assignment-meta">
                {autonomy === "ask"
                  ? t("It reads and prepares, then proposes. Nothing happens until you approve.")
                  : t("It may use the tools below on its own, toward this goal only.")}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="assignment-fieldset">
        <legend className="assignment-field-label">{t("Tools it may use")}</legend>
        {choices.map((choice) => {
          const blocked = choice.acts && draft.autonomy === "ask";
          return (
            <label
              key={choice.id}
              className="assignment-choice"
              data-blocked={blocked || undefined}
            >
              <input
                type="checkbox"
                checked={draft.tools.includes(choice.id)}
                onChange={() => toggleTool(choice.id)}
              />
              <span>
                <span className="assignment-choice-title">{choice.label}</span>
                <span className="assignment-meta">
                  {blocked ? t("Only once you approve a proposal.") : choice.detail}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {platform === "phone" && targets.length > 0 ? (
        <>
          <label className="assignment-field-label" htmlFor={ids.device}>
            {t("Runs on")}
          </label>
          <select
            id={ids.device}
            className="assignment-input"
            value={draft.deviceId ?? ""}
            onChange={(event) => {
              const target = targets.find((entry) => entry.id === event.target.value);
              update({ deviceId: target?.id, deviceName: target?.name });
            }}
          >
            <option value="">{t("This phone")}</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
          <p className="assignment-meta">
            {t(
              "Your computer runs it while Sub Rosa is open there, the menu bar included, if it accepts work from your other devices. When it does not, this phone catches up when you open it.",
            )}
          </p>
        </>
      ) : null}

      {error ? (
        <p className="assignment-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="assignment-actions">
        <button type="submit" className="assignment-button" data-tone="primary" disabled={saving}>
          {initial.id ? t("Save") : isTask ? t("Create the task") : t("Create the assignment")}
        </button>
        <button type="button" className="assignment-button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
