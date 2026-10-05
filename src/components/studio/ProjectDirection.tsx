import { useId } from "react";
import { t } from "../../lib/i18n";
import { VOCABULARY_LABELS } from "../../lib/studio/direction/labels";
import type { FilmDirection, FilmLight } from "../../lib/studio/direction/types";
import { RECIPES, recipe as findRecipe } from "../../lib/studio/direction/vocabulary";
import { lockedStyle, lockedTone } from "../../lib/studio/prompt/compose";
import { familyProfile } from "../../lib/studio/prompt/profiles";
import type { ProjectDocument } from "../../lib/studio/projects";
import { VocabularySelect } from "./VocabularySelect";

/** A recipe, as the direction it fills in: everything the bible decides once per film. */
export function directionFromRecipe(id: string): FilmDirection | undefined {
  const chosen = findRecipe(id);
  if (!chosen) return undefined;
  return {
    recipe: chosen.id,
    genre: chosen.genre,
    moods: chosen.moods.slice(0, 2),
    pacing: chosen.pacing,
    look: chosen.look,
    palette: chosen.palette,
    light: chosen.light,
    texture: chosen.texture,
    ambience: chosen.ambience,
    music: chosen.music,
    shotDefaults: { framing: chosen.shot, move: chosen.move },
  };
}

/**
 * The film's direction: genre, mood, pacing, look, palette, light, texture.
 *
 * The prompt bible decides these once per sequence and copies them word for
 * word into every shot, because the smallest variation changes the render.
 * So they live on the project, never on a shot, and the panel shows the exact
 * opening and closing every shot's prompt will carry.
 */
export function ProjectDirection({
  document,
  editDocument,
}: {
  document: ProjectDocument;
  editDocument: (change: (previous: ProjectDocument) => ProjectDocument) => void;
}) {
  const id = useId();
  const direction = document.filmDirection ?? {};
  const set = (patch: Partial<FilmDirection>) =>
    editDocument((previous) => ({
      ...previous,
      filmDirection: { ...previous.filmDirection, ...patch, recipe: undefined },
    }));
  const setLight = (patch: Partial<FilmLight>) => set({ light: { ...direction.light, ...patch } });
  const moods = direction.moods ?? [];
  const setMood = (index: number, value: string | undefined) => {
    const next = [...moods];
    next[index] = value ?? "";
    set({ moods: next.filter(Boolean).slice(0, 2) });
  };
  const profile = familyProfile(
    document.settings.videoModelId ? { id: document.settings.videoModelId } : undefined,
  );
  const tone = lockedTone(direction, profile);
  const style = lockedStyle(direction, profile);
  const proposal = document.filmDirectionProposal;
  const proposed = proposal ? lockedTone({ ...proposal }, { ...profile, budgetWords: 200 }) : "";
  const settle = (accept: boolean) =>
    editDocument((previous) => ({
      ...previous,
      filmDirection:
        accept && previous.filmDirectionProposal
          ? { ...previous.filmDirection, ...previous.filmDirectionProposal, recipe: undefined }
          : previous.filmDirection,
      filmDirectionProposal: undefined,
    }));
  return (
    <section aria-labelledby={`${id}-direction`} className="project-direction">
      <h3 id={`${id}-direction`}>{t("Film direction")}</h3>
      <p className="project-muted">
        {t("Chosen once for the whole film and written into every shot, so the shots match.")}
      </p>
      {proposal && proposed ? (
        <div className="project-direction-preview" role="status">
          <span className="project-field-heading">{t("Proposed from your script")}</span>
          <code>{proposed}</code>
          <span className="project-actions">
            <button type="button" className="btn btn-primary" onClick={() => settle(true)}>
              {t("Apply")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
              {t("Dismiss")}
            </button>
          </span>
        </div>
      ) : null}
      <label className="project-field">
        {t("Start from a recipe")}
        <select
          value={direction.recipe ?? ""}
          onChange={(event) => {
            const next = directionFromRecipe(event.target.value);
            if (next)
              editDocument((previous) => ({
                ...previous,
                filmDirection: {
                  ...next,
                  era: previous.filmDirection?.era,
                  dialogueLanguage: previous.filmDirection?.dialogueLanguage,
                  negatives: previous.filmDirection?.negatives,
                },
              }));
          }}
        >
          <option value="">{t("Choose a recipe")}</option>
          {RECIPES.map((item) => (
            <option key={item.id} value={item.id}>
              {VOCABULARY_LABELS.recipes[item.id] ?? item.id}
            </option>
          ))}
        </select>
        <span className="project-field-hint">
          {t("A recipe fills every field below. Change one at a time to see its effect.")}
        </span>
      </label>
      <VocabularySelect
        label={t("Genre")}
        category="genres"
        value={direction.genre}
        onChange={(genre) => set({ genre })}
      />
      <VocabularySelect
        label={t("Mood")}
        category="moods"
        value={moods[0]}
        onChange={(mood) => setMood(0, mood)}
      />
      {moods[0] ? (
        <VocabularySelect
          label={t("Second mood")}
          category="moods"
          value={moods[1]}
          emptyLabel={t("None")}
          onChange={(mood) => setMood(1, mood)}
        />
      ) : null}
      <VocabularySelect
        label={t("Pacing")}
        category="pacings"
        value={direction.pacing}
        onChange={(pacing) => set({ pacing })}
      />
      <VocabularySelect
        label={t("Film look")}
        category="looks"
        value={direction.look}
        onChange={(look) => set({ look })}
      />
      <VocabularySelect
        label={t("Palette")}
        category="palettes"
        value={direction.palette}
        onChange={(palette) => set({ palette })}
      />
      <details className="project-direction-more">
        <summary>{t("Light, texture and sound")}</summary>
        <p className="project-muted">
          {t(
            "Keep the light coming from the same side in every shot of a scene: it is the first mismatch the eye notices.",
          )}
        </p>
        <VocabularySelect
          label={t("Light source")}
          category="lightSources"
          value={direction.light?.source}
          onChange={(source) => setLight({ source })}
        />
        <VocabularySelect
          label={t("Light direction")}
          category="lightDirections"
          value={direction.light?.direction}
          onChange={(value) => setLight({ direction: value })}
        />
        <VocabularySelect
          label={t("Light quality")}
          category="lightQualities"
          value={direction.light?.quality}
          onChange={(quality) => setLight({ quality })}
        />
        <VocabularySelect
          label={t("Time of day")}
          category="lightMoments"
          value={direction.light?.moment}
          onChange={(moment) => setLight({ moment })}
        />
        <VocabularySelect
          label={t("Contrast")}
          category="lightContrasts"
          value={direction.light?.contrast}
          onChange={(contrast) => setLight({ contrast })}
        />
        <VocabularySelect
          label={t("Texture")}
          category="textures"
          value={direction.texture}
          onChange={(texture) => set({ texture })}
        />
        <VocabularySelect
          label={t("Background sound")}
          category="ambiences"
          value={direction.ambience}
          onChange={(ambience) => set({ ambience })}
        />
        <VocabularySelect
          label={t("Music inside the shots")}
          category="music"
          value={direction.music ?? "none"}
          emptyLabel={t("No music in the shot")}
          onChange={(music) => set({ music: music ?? "none" })}
        />
        <label className="project-field">
          {t("Period")}
          <input
            type="text"
            value={direction.era ?? ""}
            placeholder={t("In English, for example 1960s Paris")}
            onChange={(event) => set({ era: event.target.value || undefined })}
          />
          <span className="project-field-hint">
            {t("A period also keeps modern objects out of the shots.")}
          </span>
        </label>
        <label className="project-field">
          {t("Language of the lines")}
          <select
            value={direction.dialogueLanguage ?? ""}
            onChange={(event) => set({ dialogueLanguage: event.target.value || undefined })}
          >
            <option value="">{t("Detect from the script")}</option>
            <option value="fr">{t("French")}</option>
            <option value="en">{t("English")}</option>
          </select>
          <span className="project-field-hint">
            {t(
              "A model speaks a line itself only in a language it knows; otherwise the line is dubbed.",
            )}
          </span>
        </label>
      </details>
      {tone || style ? (
        <div className="project-direction-preview">
          <span className="project-field-heading">{t("Written into every shot")}</span>
          {tone ? <code>{tone}</code> : null}
          {style ? <code>{style}</code> : null}
        </div>
      ) : null}
    </section>
  );
}
