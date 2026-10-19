// Starter workflows that make music, a voice or a mix.

import { FED_PARAMS_KEY, FED_PORT_PREFIX, type Workflow } from "../schema";
import { t } from "../../../i18n";
import { CHAT_MODEL, EFFECTS_MODEL, edge, MUSIC_MODEL, node, TTS_MODEL } from "./build";

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

/** A sound effect for each line of a list
 * (ComfyUI: api_elevenlabs_text_to_sound_effects). */
export function soundEffectsPack(): Workflow {
  return {
    id: "template-sound-effects-pack",
    name: t("Sound effects pack"),
    description: t("One sound effect for each line you write."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("sounds", "textList", t("Sounds"), 0, 0, {
        items:
          "an old wooden door creaking open slowly\nheavy rain on a tin roof\nfootsteps on fresh snow\na distant thunder rumble rolling away",
      }),
      node("effect", "music", t("Effect"), 1, 0, {
        model: EFFECTS_MODEL,
        durationSeconds: 5,
      }),
      node("out", "output", t("Effects"), 2, 0),
    ],
    app: {
      fields: [{ nodeId: "sounds", param: "items", label: t("Sounds, one per line") }],
      outputs: ["out"],
      intro: t("Describe some sounds, get an effect for each."),
    },
    edges: [edge("sounds", "effect", "prompt"), edge("effect", "out")],
  };
}

/** A story told as a song: its lyrics written first, then sung in the style
 * asked for (ComfyUI: audio_ace_step_1_5, audio_minimax_music_3). */
export function songFromAStory(): Workflow {
  return {
    id: "template-song-from-a-story",
    name: t("Song from a story"),
    description: t("A story turned into lyrics, then sung in the style you choose."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("story", "textInput", t("Story"), 0, 0, {
        text: "Two old friends meet again at the station where they said goodbye twenty years ago.",
      }),
      node("lyrics", "chat", t("Lyrics"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write song lyrics that tell this story: two verses and a chorus sung twice, short singable lines, under 900 characters. Mark the parts as [Verse] and [Chorus]. Reply with the lyrics only.\n\n{{input}}",
      }),
      // The style is a step of its own: a music step takes its prompt from a
      // connection, not from a setting an app could show.
      node("style", "textInput", t("The style"), 0, 1, {
        text: "warm indie folk, acoustic guitar and soft piano, an intimate voice, a gentle build",
      }),
      node("song", "music", t("Song"), 2, 0, {
        model: MUSIC_MODEL,
        durationSeconds: 120,
        [FED_PARAMS_KEY]: ["lyrics"],
      }),
      node("out", "output", t("Song"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "story", param: "text", label: t("Your story") },
        { nodeId: "style", param: "text", label: t("The style") },
      ],
      outputs: ["out"],
      intro: t("Tell a story and choose a style, get it as a song."),
    },
    edges: [
      edge("story", "lyrics"),
      edge("style", "song", "prompt"),
      edge("lyrics", "song", `${FED_PORT_PREFIX}lyrics`),
      edge("song", "out"),
    ],
  };
}

/** A short exchange between two voices: written once, each line taken out
 * of it and read by its speaker, the lines laid end to end by the mix
 * (ComfyUI: api_elevenlabs_text_to_dialogue). */
export function twoVoiceDialogue(): Workflow {
  const line = (index: number) =>
    node(`line-${index}`, "chat", t("Line {index}", { index }), 2, index - 1, {
      model: CHAT_MODEL,
      temperature: 0,
      prompt: `Reply with line ${index} of this dialogue exactly as it is written, without the speaker's name and with nothing else.\n\n{{input}}`,
    });
  const voice = (index: number, speaker: string) =>
    node(`voice-${index}`, "tts", t("Voice {index}", { index }), 3, index - 1, {
      model: TTS_MODEL,
      voice: speaker,
    });
  const lines = [1, 2, 3, 4];
  return {
    id: "template-two-voice-dialogue",
    name: t("Two-voice dialogue"),
    description: t("A short exchange written for two voices, read and mixed line by line."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("topic", "textInput", t("Topic"), 0, 0, {
        text: "A bookshop owner tries to convince a customer that the book chooses its reader.",
      }),
      node("script", "chat", t("Dialogue"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          'Write a four-line dialogue about this between two people, A and B, who speak in turn: A, B, A, B. One line each, natural and spoken, under 30 words each. Write each line as "A: ..." or "B: ..." on its own line, with nothing else.\n\n{{input}}',
      }),
      ...lines.map(line),
      ...lines.map((index) => voice(index, index % 2 === 1 ? "af_heart" : "am_michael")),
      node("mix", "soundMix", t("Mix"), 4, 0),
      node("out", "output", t("Dialogue"), 5, 0),
    ],
    app: {
      fields: [{ nodeId: "topic", param: "text", label: t("What they talk about") }],
      outputs: ["out"],
      intro: t("Say what two people talk about, hear them talk."),
    },
    edges: [
      edge("topic", "script"),
      ...lines.flatMap((index) => [
        edge("script", `line-${index}`),
        edge(`line-${index}`, `voice-${index}`, "text"),
        // Laid end to end in connection order: line 1, then 2, 3 and 4.
        edge(`voice-${index}`, "mix", "dialogue"),
      ]),
      edge("mix", "out"),
    ],
  };
}
