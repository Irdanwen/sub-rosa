import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconClapboard } from "central-icons/IconClapboard";
import { IconSoundFx } from "central-icons/IconSoundFx";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconAudio } from "central-icons/IconAudio";
import { IconVideo } from "central-icons/IconVideo";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import {
  modelsOfType,
  musicModels,
  soundEffectsModels,
  videoFamilies,
} from "../../lib/studio/catalog";
import type { MediaCatalog } from "../../lib/studio/types";
import type { AudioMode } from "./AudioStudio";
import "../../styles/studio-start.css";

export type StudioDestination = {
  tab: "image" | "video" | "audio" | "film" | "workflows" | "bible" | "assemble";
  audioMode?: AudioMode;
};

/** A choice of outcomes over the very same catalog and tools as the workshops. */
export function StudioStart({
  catalog,
  onOpen,
}: {
  catalog: MediaCatalog;
  onOpen: (destination: StudioDestination) => void;
}) {
  const images = modelsOfType(catalog, "image").length;
  const videos = videoFamilies(catalog).length;
  const music = musicModels(catalog).length;
  const voices = modelsOfType(catalog, "tts").length;
  const effects = soundEffectsModels(catalog).length;
  const canPlanFilm = modelsOfType(catalog, "text").length > 0 && videos > 0;
  const choices: {
    id: string;
    title: string;
    description: string;
    icon: ReactNode;
    count: number;
    destination: StudioDestination;
  }[] = [
    {
      id: "image",
      title: t("Create an image"),
      description: t("Explore a visual idea, from a first sketch to the final frame."),
      icon: <IconCameraSparkle size={24} />,
      count: images,
      destination: { tab: "image" },
    },
    {
      id: "video",
      title: t("Bring a scene to life"),
      description: t("Start with words or an image. Compare video models on the same idea."),
      icon: <IconVideo size={24} />,
      count: videos,
      destination: { tab: "video" },
    },
    {
      id: "speech",
      title: t("Give your words a voice"),
      description: t("Turn a script into narration with a voice you choose."),
      icon: <IconMicrophone size={24} />,
      count: voices,
      destination: { tab: "audio", audioMode: "speech" },
    },
    {
      id: "music",
      title: t("Compose a soundtrack"),
      description: t("Create a song or an instrumental around your mood and story."),
      icon: <IconAudio size={24} />,
      count: music,
      destination: { tab: "audio", audioMode: "music" },
    },
    {
      id: "sfx",
      title: t("Design a sound"),
      description: t("Describe the atmosphere, texture or effect your scene needs."),
      icon: <IconSoundFx size={24} />,
      count: effects,
      destination: { tab: "audio", audioMode: "sfx" },
    },
  ];
  return (
    <div className="studio-start">
      <section className="studio-start-intro" aria-labelledby="studio-start-title">
        <div>
          <p className="studio-start-eyebrow">{t("Your creative workspace")}</p>
          <h2 id="studio-start-title">{t("What will you make?")}</h2>
          <p>
            {t("One idea, many ways to create. Choose an outcome, then find the model that fits.")}
          </p>
        </div>
        <span className="studio-start-note">
          {t("You review the settings before anything runs.")}
        </span>
      </section>
      <section className="studio-start-grid" aria-label={t("Choose what to create")}>
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="studio-start-card"
            data-kind={choice.id}
            disabled={choice.count === 0}
            onClick={() => onOpen(choice.destination)}
          >
            <span className="studio-start-card-top">
              <span className="studio-start-icon" aria-hidden="true">
                {choice.icon}
              </span>
              <IconArrowUpRight size={18} aria-hidden="true" />
            </span>
            <span className="studio-start-card-title">{choice.title}</span>
            <span className="studio-start-description">{choice.description}</span>
            <span className="studio-start-count">
              {choice.count === 0
                ? t("No models available")
                : choice.id === "video"
                  ? choice.count === 1
                    ? t("1 video family")
                    : t("{count} video families", { count: choice.count })
                  : choice.count === 1
                    ? t("1 model available")
                    : t("{count} models available", { count: choice.count })}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="studio-start-card studio-start-film"
          disabled={!canPlanFilm}
          onClick={() => onOpen({ tab: "film" })}
        >
          <span className="studio-start-card-top">
            <span className="studio-start-icon" aria-hidden="true">
              <IconClapboard size={24} />
            </span>
            <IconArrowUpRight size={18} aria-hidden="true" />
          </span>
          <span className="studio-start-card-title">{t("Make a complete film")}</span>
          <span className="studio-start-description">
            {t("Shape a story, keep your cast consistent, and bring the shots together.")}
          </span>
          <span className="studio-start-count">
            {canPlanFilm
              ? t("From an idea to a finished sequence")
              : t("Text and video models required")}
          </span>
        </button>
      </section>
      <section className="studio-start-tools" aria-label={t("Continue your creative work")}>
        <div>
          <h3>{t("Go further with your creations")}</h3>
          <p>
            {t("Keep your cast consistent, build a repeatable process, or assemble the final cut.")}
          </p>
        </div>
        <div className="studio-start-tool-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpen({ tab: "bible" })}
          >
            {t("Build your cast")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpen({ tab: "workflows" })}
          >
            {t("Connect a workflow")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpen({ tab: "assemble" })}
          >
            {t("Assemble your clips")}
          </button>
        </div>
      </section>
    </div>
  );
}
