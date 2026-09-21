import { t } from "../../lib/i18n";

/** Templates are starting intentions, never saved profiles or implicit grants. */
export function assistantTemplates() {
  return [
    {
      id: "research",
      name: t("Research partner"),
      description: t("Explore a subject, compare sources and make your findings clear."),
      prompt: t(
        "Create a research assistant that compares sources, cites evidence and clearly separates facts from uncertainty.",
      ),
    },
    {
      id: "writing",
      name: t("Writing partner"),
      description: t("Develop your ideas and find the words that sound like you."),
      prompt: t(
        "Create a writing assistant that helps develop ideas, structure drafts and refine my voice without replacing it.",
      ),
    },
    {
      id: "language",
      name: t("Language tutor"),
      description: t("Practice real conversations with patient, useful corrections."),
      prompt: t(
        "Create a language tutor that adapts to my level, practices conversation and explains corrections with examples.",
      ),
    },
    {
      id: "brand",
      name: t("Brand designer"),
      description: t("Shape a visual identity, from first ideas to finished images."),
      prompt: t(
        "Create a brand design assistant that asks about the audience and values, proposes distinct visual directions and helps create logos, palettes and mockups.",
      ),
    },
    {
      id: "film",
      name: t("Film creator"),
      description: t("Turn an idea into characters, scenes, images and sound."),
      prompt: t(
        "Create a film assistant that develops a story, characters, a shot list and consistent image, video and sound prompts.",
      ),
    },
    {
      id: "roleplay",
      name: t("Game master"),
      description: t("Build a world and explore stories shaped by your choices."),
      prompt: t(
        "Create a role-playing assistant that builds an immersive fictional world, remembers story continuity and lets the player decide their own actions.",
      ),
    },
  ];
}

export function assistantQuestions() {
  return [
    {
      id: "audience",
      label: t("Who will this assistant help?"),
      type: "single" as const,
      options: [t("Just me"), t("My team"), t("A particular audience")],
    },
    {
      id: "style",
      label: t("How should it work with you?"),
      type: "multiple" as const,
      options: [
        t("Ask questions first"),
        t("Be concise"),
        t("Explain with examples"),
        t("Challenge my ideas"),
      ],
    },
    {
      id: "outcome",
      label: t("What should a good result look like?"),
      type: "text" as const,
      options: [],
    },
    {
      id: "boundaries",
      label: t("What should it know or avoid?"),
      type: "text" as const,
      options: [],
    },
  ];
}
