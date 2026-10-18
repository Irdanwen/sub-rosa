// Starter workflows that make music, a voice or a mix.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { CHAT_MODEL, TTS_MODEL, MUSIC_MODEL, edge, node } from "./build";

export function musicFromMood(): Workflow {
  return {
    id: "template-music-from-mood",
    name: t("Music from a mood"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", t("Mood"), 0, 0, {
        text: "Late night rain against the window, warm coffee, quiet optimism.",
      }),
      node("brief", "chat", t("Music brief"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Turn this mood into a short music brief: genre, tempo, instrumentation, and overall feel. Two sentences maximum, no lyrics. Reply with the brief only.\n\n{{input}}",
      }),
      node("track", "music", t("Track"), 2, 0, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 90,
      }),
      node("out", "output", t("Track"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "input", param: "text", label: t("The mood") }],
      outputs: ["out"],
      intro: t("Describe a mood, get a track."),
    },
    edges: [edge("input", "brief"), edge("brief", "track"), edge("track", "out")],
  };
}

/** A spoken intro over its own music, the music lowered under the voice. */
export function podcastIntro(): Workflow {
  return {
    id: "template-podcast-intro",
    name: t("Podcast intro"),
    description: t("A few lines read aloud over a short score, mixed and levelled."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("lines", "textInput", t("Lines"), 0, 0, {
        text: "Welcome back to Small Hours, the show about the work people do while the rest of us sleep.",
      }),
      node("voice", "tts", t("Voice"), 1, 0, { model: TTS_MODEL }),
      node("brief", "textInput", t("Music brief"), 0, 1, {
        text: "Warm lo-fi intro, soft keys and brushed drums, calm and inviting.",
      }),
      node("score", "music", t("Music"), 1, 1, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 30,
      }),
      node("mix", "soundMix", t("Mix"), 2, 0, { audioVolume: 0.5 }),
      node("out", "output", t("Intro"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "lines", param: "text", label: t("What the voice says") },
        { nodeId: "brief", param: "text", label: t("The music") },
      ],
      outputs: ["out"],
      intro: t("Write a few lines and describe the music, get the intro."),
    },
    edges: [
      edge("lines", "voice", "text"),
      edge("brief", "score", "prompt"),
      edge("voice", "mix", "dialogue"),
      edge("score", "mix", "music"),
      edge("mix", "out"),
    ],
  };
}

/** A text translated, then read aloud in that language. */
export function readInAnotherLanguage(): Workflow {
  return {
    id: "template-read-in-another-language",
    name: t("Read it in another language"),
    description: t("A text translated, then read aloud in the new language."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("text", "textInput", t("Text"), 0, 0, {
        text: "Thank you for coming tonight. The doors open at eight, and the first act starts at half past.",
      }),
      node("translate", "chat", t("Translation"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Translate this text into Spanish, natural and spoken in tone. Reply with the translation only.\n\n{{input}}",
      }),
      node("voice", "tts", t("Voice"), 2, 0, { model: TTS_MODEL }),
      node("out", "output", t("Spoken"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "text", param: "text", label: t("Your text") }],
      outputs: ["out"],
      intro: t("Write a text, hear it in another language."),
    },
    edges: [edge("text", "translate"), edge("translate", "voice", "text"), edge("voice", "out")],
  };
}
