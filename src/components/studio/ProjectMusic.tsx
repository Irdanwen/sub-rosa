import { type CSSProperties, useId, useState } from "react";
import { intlLocale, t } from "../../lib/i18n";
import { artifactSrc } from "../../lib/studio/artifacts";
import { musicCapabilities, musicModels } from "../../lib/studio/catalog";
import type { LiveRender } from "../../lib/studio/project-activity";
import { cueLength, shotSeconds } from "../../lib/studio/project-production";
import type { ProjectDocument } from "../../lib/studio/projects";
import { estimateRenderMs } from "../../lib/studio/render-eta";
import {
  type CueIntensity,
  cueShots,
  cueSpan,
  emptyScore,
  newCue,
  type ProjectCue,
  type ProjectScore,
  projectScore,
  type ScoreMode,
  type ScoreProposal,
} from "../../lib/studio/score";
import { rewriteTargetModel } from "../../lib/studio/studio-rewrite";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Switch } from "../ui/Switch";
import { AiRewrite } from "./AiRewrite";
import { Darkroom } from "./Darkroom";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";
import { ModelField } from "./ProjectScript";

/**
 * The film's music (ADR-0067), read from the script like the bible is and
 * made like the shots are: each cue has a prompt, a length the app computes
 * from the shots it plays under, and takes to choose between.
 */
export function ProjectMusic({
  document,
  catalog,
  artifacts,
  onScore,
  onSettings,
  onGenerate,
  onCompose,
  proposal,
  proposing,
  onAcceptProposal,
  onDiscardProposal,
  writingModelId,
  busy,
  live = [],
  now = Date.now(),
  fresh,
}: {
  document: ProjectDocument;
  catalog: MediaCatalog;
  artifacts: StudioArtifact[];
  onScore: (score: ProjectScore) => void;
  onSettings: (patch: Partial<ProjectDocument["settings"]>) => void;
  onGenerate: (cueId: string) => void;
  onCompose: () => void;
  proposal?: ScoreProposal;
  proposing: boolean;
  onAcceptProposal: () => void;
  onDiscardProposal: () => void;
  writingModelId?: string;
  busy: boolean;
  live?: readonly LiveRender[];
  now?: number;
  fresh?: ReadonlySet<string>;
}) {
  const stored = projectScore(document);
  const score = stored ?? emptyScore();
  const [selected, setSelected] = useState<string>();
  const productionSwitch = useId();
  const cue = score.cues.find((item) => item.id === selected) ?? score.cues[0];
  const shots = document.shots;
  const seconds = new Map(shots.map((shot) => [shot.id, shotSeconds(shot, document, catalog)]));
  const total = shots.reduce((sum, shot) => sum + (seconds.get(shot.id) ?? 0), 0);
  const startOf = (shotId: string) => {
    let at = 0;
    for (const shot of shots) {
      if (shot.id === shotId) return at;
      at += seconds.get(shot.id) ?? 0;
    }
    return at;
  };
  const models = musicModels(catalog);
  const length = cue ? cueLength(document, catalog, cue) : undefined;
  const caps = length?.model ? musicCapabilities(length.model.id) : undefined;
  const wait = live.find((item) => item.target.kind === "cue" && item.target.cueId === cue?.id);
  const number = (value: number) =>
    value.toLocaleString(intlLocale(), { maximumFractionDigits: 0 });

  const save = (next: ProjectScore) => onScore(next);
  const updateCue = (patch: Partial<ProjectCue>) =>
    cue &&
    save({
      ...score,
      cues: score.cues.map((item) => (item.id === cue.id ? { ...item, ...patch } : item)),
    });
  const addCue = () => {
    const last = score.cues[score.cues.length - 1];
    const after = last ? shots.findIndex((shot) => shot.id === last.toShotId) + 1 : 0;
    const from = shots[Math.min(after, shots.length - 1)];
    if (!from) return;
    const next = newCue(from.id, from.id);
    save({ ...score, cues: [...score.cues, next] });
    setSelected(next.id);
  };
  const setMode = (mode: ScoreMode) => save({ ...score, mode });

  if (!shots.length)
    return (
      <div className="project-empty">
        <h2>{t("The music follows the shots")}</h2>
        <p>{t("Break your script into shots first. Each cue plays under a run of them.")}</p>
      </div>
    );

  return (
    <div className="project-music">
      <header className="project-music-header">
        <div>
          <h2>{t("Music")}</h2>
          <p className="project-muted">
            {t("Read from the script, timed from the shots, made like a take.")}
          </p>
        </div>
        <div className="project-actions">
          <SegmentedControl
            aria-label={t("Score")}
            value={score.mode}
            onValueChange={setMode}
            options={[
              { value: "single", label: t("One piece") },
              { value: "cues", label: t("Cue sheet") },
            ]}
          />
          <button
            type="button"
            className={score.cues.length ? "btn btn-secondary" : "btn btn-primary"}
            disabled={busy || proposing}
            onClick={onCompose}
          >
            {proposing ? t("Reading your script...") : t("Compose from the script")}
          </button>
        </div>
      </header>

      {proposal ? (
        <section className="ai-rewrite-proposal" aria-label={t("Proposed score")}>
          <header>
            <span>{t("Proposed score")}</span>
          </header>
          <p>{proposal.identity}</p>
          <ol className="project-music-proposal">
            {proposal.cues.map((item) => (
              <li key={`${item.from}-${item.to}-${item.title}`}>
                <strong>{item.title}</strong>
                <span className="project-muted">
                  {item.from === item.to
                    ? t("Shot {number}", { number: item.from + 1 })
                    : t("Shots {first} to {last}", { first: item.from + 1, last: item.to + 1 })}
                  {item.mood ? ` · ${item.mood}` : ""}
                </span>
                <span>{item.prompt}</span>
              </li>
            ))}
          </ol>
          {score.cues.length ? (
            <p className="project-muted">
              {t(
                "Accepting replaces the cues. Takes stay with a cue whose shots did not change, and every take stays in Media.",
              )}
            </p>
          ) : null}
          <footer>
            <button type="button" className="btn btn-primary" onClick={onAcceptProposal}>
              {t("Accept")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDiscardProposal}>
              {t("Discard")}
            </button>
          </footer>
        </section>
      ) : null}

      <div className="project-music-strip" aria-hidden>
        <div className="project-music-shots">
          {shots.map((shot, index) => (
            <span
              key={shot.id}
              title={shot.title}
              style={{ flexGrow: seconds.get(shot.id) ?? 1 } as CSSProperties}
            >
              {index + 1}
            </span>
          ))}
        </div>
        <div className="project-music-cues">
          {score.cues.map((item, index) => {
            const covered = cueShots(shots, item);
            if (!covered.length || !total) return null;
            const from = startOf(covered[0].id);
            const span = covered.reduce((sum, shot) => sum + (seconds.get(shot.id) ?? 0), 0);
            return (
              <button
                type="button"
                key={item.id}
                tabIndex={-1}
                data-selected={item.id === cue?.id}
                data-tone={index % 4}
                style={{ left: `${(from / total) * 100}%`, width: `${(span / total) * 100}%` }}
                onClick={() => setSelected(item.id)}
              >
                {item.title}
              </button>
            );
          })}
        </div>
      </div>

      <div className="project-music-grid">
        <aside className="project-panel">
          <div className="project-actions">
            <h3>{score.mode === "single" ? t("The piece") : t("Cues")}</h3>
            {score.mode === "cues" ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={addCue}>
                {t("Add a cue")}
              </button>
            ) : null}
          </div>
          {score.cues.map((item) => {
            const span = cueSpan(shots, item);
            const itemWait = live.some(
              (render) => render.target.kind === "cue" && render.target.cueId === item.id,
            );
            return (
              <button
                type="button"
                key={item.id}
                className="project-list-item"
                aria-pressed={item.id === cue?.id}
                onClick={() => setSelected(item.id)}
              >
                <strong>
                  {item.title}
                  {itemWait ? (
                    <span className="project-live-dot" role="img" aria-label={t("In production")} />
                  ) : null}
                </strong>
                <span>
                  {span
                    ? span.first === span.last
                      ? t("Shot {number}", { number: span.first })
                      : t("Shots {first} to {last}", span)
                    : t("Choose its shots")}
                  {item.takeIds.length
                    ? ` · ${
                        item.takeIds.length === 1
                          ? t("1 take")
                          : t("{count} takes", { count: item.takeIds.length })
                      }`
                    : ""}
                </span>
              </button>
            );
          })}
          {!score.cues.length ? (
            <p className="project-muted">
              {t("Compose from the script, or add a cue and write it yourself.")}
            </p>
          ) : null}
        </aside>

        {cue ? (
          <section className="project-panel project-music-editor">
            <fieldset disabled={busy}>
              <label className="project-field">
                {t("Cue title")}
                <input
                  value={cue.title}
                  onChange={(event) => updateCue({ title: event.target.value })}
                />
              </label>
              {score.mode === "cues" ? (
                <div className="project-two-columns">
                  <label className="project-field">
                    {t("From shot")}
                    <select
                      value={cue.fromShotId}
                      onChange={(event) => updateCue({ fromShotId: event.target.value })}
                    >
                      {shots.map((shot, index) => (
                        <option key={shot.id} value={shot.id}>
                          {t("{number}. {title}", { number: index + 1, title: shot.title })}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="project-field">
                    {t("To shot")}
                    <select
                      value={cue.toShotId}
                      onChange={(event) => updateCue({ toShotId: event.target.value })}
                    >
                      {shots.map((shot, index) => (
                        <option key={shot.id} value={shot.id}>
                          {t("{number}. {title}", { number: index + 1, title: shot.title })}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              <div className="project-two-columns">
                <label className="project-field">
                  {t("Mood")}
                  <input
                    value={cue.mood}
                    placeholder={t("For example: hushed, uneasy")}
                    onChange={(event) => updateCue({ mood: event.target.value })}
                  />
                </label>
                <label className="project-field">
                  {t("Intensity")}
                  <select
                    value={cue.intensity}
                    onChange={(event) =>
                      updateCue({ intensity: event.target.value as CueIntensity })
                    }
                  >
                    <option value="low">{t("Soft")}</option>
                    <option value="medium">{t("Moderate")}</option>
                    <option value="high">{t("Intense")}</option>
                  </select>
                </label>
              </div>
              <div className="project-field">
                <span className="project-field-heading">{t("Music prompt")}</span>
                <AiRewrite
                  label={t("Music prompt")}
                  value={cue.prompt}
                  disabled={busy}
                  onAccept={(prompt) =>
                    updateCue({
                      prompt,
                      promptOptimizedFor: prompt ? length?.model?.id : undefined,
                    })
                  }
                  hint={t("Written in English, the language these music models follow best.")}
                  field={
                    <textarea
                      aria-label={t("Music prompt")}
                      rows={4}
                      value={cue.prompt}
                      placeholder={t("What this cue adds to the score, and how it moves")}
                      onChange={(event) => updateCue({ prompt: event.target.value })}
                    />
                  }
                  status={
                    cue.promptOptimizedFor && cue.promptOptimizedFor === length?.model?.id ? (
                      <span className="project-badge">
                        {t("Optimized for {model}", { model: length.model.name })}
                      </span>
                    ) : null
                  }
                  request={() =>
                    cue.prompt.trim() || cue.mood.trim() || cueShots(shots, cue).length
                      ? {
                          kind: "musicPrompt",
                          text: cue.prompt,
                          modelId: writingModelId,
                          context: {
                            targetModel: rewriteTargetModel(length?.model),
                            title: cue.title,
                            identity: score.identity,
                            mood: cue.mood,
                            intensity: cue.intensity,
                            duration: length ? String(Math.round(length.wanted)) : undefined,
                            scenes: cueShots(shots, cue).map(
                              (shot) => `${shot.title}: ${shot.action}`,
                            ),
                          },
                        }
                      : undefined
                  }
                />
              </div>
              {caps && caps.lyrics !== "none" ? (
                <label className="project-field">
                  {caps.lyrics === "required"
                    ? t("Lyrics (this model sings)")
                    : t("Lyrics, optional")}
                  <textarea
                    rows={3}
                    value={cue.lyrics ?? ""}
                    onChange={(event) => updateCue({ lyrics: event.target.value || undefined })}
                  />
                </label>
              ) : null}
              {length && length.wanted > 0 ? (
                <p className="project-muted">
                  {length.seconds === undefined
                    ? t(
                        "About {seconds} s under its shots. This model chooses its own length; the montage trims what runs over.",
                        {
                          seconds: number(length.wanted),
                        },
                      )
                    : length.longer
                      ? t(
                          "About {seconds} s under its shots. This model writes at least {made} s; the montage trims what runs over.",
                          {
                            seconds: number(length.wanted),
                            made: number(length.seconds),
                          },
                        )
                      : length.shorter
                        ? t(
                            "About {seconds} s under its shots, longer than the {made} s this model writes. Split it into two cues.",
                            {
                              seconds: number(length.wanted),
                              made: number(length.seconds),
                            },
                          )
                        : t("{seconds} s, the length of its shots.", {
                            seconds: number(length.seconds),
                          })}
                </p>
              ) : (
                <p className="project-warning">
                  {t("Choose the shots this cue plays under first.")}
                </p>
              )}
            </fieldset>
            <div className="project-actions">
              <h3>{t("Takes")}</h3>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !cueShots(shots, cue).length}
                onClick={() => onGenerate(cue.id)}
              >
                {t("Quote a new take")}
              </button>
            </div>
            {wait ? (
              <Darkroom
                variant="audio"
                compact
                seed={`${cue.id}${cue.prompt}`}
                phase={wait.phase}
                elapsedMs={now - wait.startedAt}
                estimateMs={estimateRenderMs(wait.etaKey)}
                progress={wait.progress}
                label={wait.phase === "queued" ? undefined : t("Composing")}
              />
            ) : null}
            <div className="project-music-takes">
              {cue.takeIds.map((id, index) => {
                const take = artifacts.find((item) => item.id === id);
                return (
                  <div
                    key={id}
                    className={`project-take${fresh?.has(id) ? " project-reveal" : ""}`}
                    aria-current={cue.activeTakeId === id ? "true" : undefined}
                  >
                    <strong>{t("Take {number}", { number: index + 1 })}</strong>
                    {take ? (
                      // biome-ignore lint/a11y/useMediaCaption: generated music has no caption track
                      <audio
                        controls
                        preload="none"
                        src={artifactSrc(take)}
                        aria-label={t("Take {number}", { number: index + 1 })}
                      />
                    ) : (
                      <small>{t("Missing file")}</small>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || !take || cue.activeTakeId === id}
                      onClick={() => updateCue({ activeTakeId: id })}
                    >
                      {cue.activeTakeId === id ? t("Selected") : t("Select this take")}
                    </button>
                  </div>
                );
              })}
            </div>
            {score.mode === "cues" ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() =>
                  save({ ...score, cues: score.cues.filter((item) => item.id !== cue.id) })
                }
              >
                {t("Remove this cue")}
              </button>
            ) : null}
          </section>
        ) : (
          <div className="project-empty">
            <h3>{t("No music yet")}</h3>
            <p>
              {t(
                "Compose it from the script: the app reads where music helps and what it sounds like.",
              )}
            </p>
          </div>
        )}

        <aside className="project-panel project-settings">
          <section>
            <h3>{t("The score")}</h3>
            <label className="project-field">
              {t("Musical identity")}
              <textarea
                rows={4}
                value={score.identity}
                disabled={busy}
                placeholder={t("Genre, instruments, tempo and colour every cue shares")}
                onChange={(event) => save({ ...score, identity: event.target.value })}
              />
            </label>
            <ModelField
              label={t("Music model")}
              automatic={t("The model that writes the longest pieces.")}
              value={document.settings.musicModelId}
              onReset={() => onSettings({ musicModelId: "" })}
            >
              <MediaModelPicker
                value={document.settings.musicModelId}
                options={models.map(mediaModelOption)}
                ariaLabel={t("Music model")}
                placeholder={t("Automatic")}
                onChange={(musicModelId) => onSettings({ musicModelId })}
              />
            </ModelField>
            <div className="project-field project-field-inline">
              <span id={productionSwitch}>{t("Compose it with the full production")}</span>
              <Switch
                aria-labelledby={productionSwitch}
                checked={document.settings.withScore}
                onCheckedChange={(withScore) => onSettings({ withScore })}
              />
            </div>
            {!stored ? null : (
              <p className="project-muted">
                {t("{count} cues, {seconds} s of film.", {
                  count: score.cues.length,
                  seconds: number(total),
                })}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
