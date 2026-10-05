import { t } from "../../lib/i18n";
import type { CameraMove, ShotFraming } from "../../lib/studio/direction/types";
import { entry } from "../../lib/studio/direction/vocabulary";
import type { ProjectDocument, ProjectShot } from "../../lib/studio/projects";
import { VocabularySelect } from "./VocabularySelect";

/**
 * A shot's camera, line and sound, in the prompt bible's vocabulary.
 *
 * Two choices are always in view, the frame and the one camera movement,
 * because those are what the bible never leaves to the model. Everything
 * else waits in a fold: a shot left alone takes the film's defaults.
 */
export function ShotCameraFields({
  shot,
  document,
  update,
}: {
  shot: ProjectShot;
  document: ProjectDocument;
  update: (patch: Partial<ProjectShot>) => void;
}) {
  const defaults = document.filmDirection?.shotDefaults;
  const framing = shot.framing ?? {};
  const move = shot.move ?? {};
  const setFraming = (patch: Partial<ShotFraming>) => update({ framing: { ...framing, ...patch } });
  const setMove = (patch: Partial<CameraMove>) => update({ move: { ...move, ...patch } });
  const still = entry("movements", move.kind)?.still;
  return (
    <div className="project-field-group">
      <VocabularySelect
        label={t("Frame")}
        category="shotSizes"
        value={framing.size}
        emptyLabel={defaults?.framing?.size ? t("Film default") : t("Not set")}
        onChange={(size) => setFraming({ size })}
      />
      <VocabularySelect
        label={t("Camera movement")}
        category="movements"
        value={move.kind}
        emptyLabel={defaults?.move?.kind ? t("Film default") : t("Not set")}
        onChange={(kind) => setMove({ kind })}
      />
      <details className="project-direction-more">
        <summary>{t("Lens, angle and movement")}</summary>
        <VocabularySelect
          label={t("Lens")}
          category="lenses"
          value={framing.lens}
          onChange={(lens) => setFraming({ lens })}
        />
        <VocabularySelect
          label={t("Depth of field")}
          category="depths"
          value={framing.depth}
          onChange={(depth) => setFraming({ depth })}
        />
        <VocabularySelect
          label={t("Angle")}
          category="angles"
          value={framing.angle}
          onChange={(angle) => setFraming({ angle })}
        />
        {move.kind && !still ? (
          <>
            <VocabularySelect
              label={t("Amplitude")}
              category="amplitudes"
              value={move.amplitude}
              onChange={(amplitude) => setMove({ amplitude })}
            />
            <VocabularySelect
              label={t("Speed")}
              category="speeds"
              value={move.speed}
              onChange={(speed) => setMove({ speed })}
            />
          </>
        ) : null}
        <VocabularySelect
          label={t("Joins the previous shot with")}
          category="transitions"
          value={shot.transition}
          emptyLabel={t("A hard cut")}
          onChange={(transition) => update({ transition })}
        />
        <label className="project-field">
          {t("Camera notes")}
          <textarea
            aria-label={t("Camera notes")}
            value={shot.camera}
            placeholder={t("Only what the choices above cannot say")}
            onChange={(event) => update({ camera: event.target.value })}
          />
        </label>
      </details>
    </div>
  );
}

export function ShotLineFields({
  shot,
  update,
}: {
  shot: ProjectShot;
  update: (patch: Partial<ProjectShot>) => void;
}) {
  return (
    <>
      <VocabularySelect
        label={t("Tone")}
        category="tones"
        value={shot.tone}
        onChange={(tone) => update({ tone })}
      />
      <VocabularySelect
        label={t("Delivery")}
        category="paces"
        value={shot.pace}
        onChange={(pace) => update({ pace })}
      />
      <label className="project-field project-field-inline">
        <span>{t("Heard, not said on screen")}</span>
        <input
          type="checkbox"
          checked={shot.voiceover === true}
          onChange={(event) => update({ voiceover: event.target.checked || undefined })}
        />
      </label>
      <label className="project-field">
        {t("Who speaks the line")}
        <select
          value={shot.dialogueMode ?? "auto"}
          onChange={(event) =>
            update({
              dialogueMode:
                event.target.value === "auto"
                  ? undefined
                  : (event.target.value as ProjectShot["dialogueMode"]),
            })
          }
        >
          <option value="auto">{t("The video model when it can, a voice otherwise")}</option>
          <option value="native">{t("The video model, with lip sync")}</option>
          <option value="dubbed">{t("A voice laid in afterwards")}</option>
        </select>
      </label>
    </>
  );
}

export function ShotSoundFields({
  shot,
  update,
}: {
  shot: ProjectShot;
  update: (patch: Partial<ProjectShot>) => void;
}) {
  const setState = (name: string, state: string) => {
    const states = { ...shot.states, [name]: state };
    if (!state.trim()) delete states[name];
    update({ states: Object.keys(states).length ? states : undefined });
  };
  return (
    <details className="project-direction-more">
      <summary>{t("Sound and continuity")}</summary>
      <label className="project-field">
        {t("Sounds of the action")}
        <input
          value={shot.effects ?? ""}
          placeholder={t("In English, for example paper rustling, a slow breath")}
          onChange={(event) => update({ effects: event.target.value || undefined })}
        />
      </label>
      {shot.characters.map((name) => (
        <label key={name} className="project-field">
          {t("{name} in this shot", { name })}
          <input
            value={shot.states?.[name] ?? ""}
            placeholder={t("In English, what differs: coat unbuttoned, hair wet")}
            onChange={(event) => setState(name, event.target.value)}
          />
        </label>
      ))}
    </details>
  );
}
