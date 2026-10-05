/**
 * What each value of the prompt vocabulary is called on screen, and what it
 * does to the picture.
 *
 * The values themselves (`vocabulary.json`) are the English the models read,
 * shared with Rust. The labels live here, as literal `t()` calls, because the
 * catalog extractor only collects literals (spec/copy-through-t.md).
 * Generated from the prompt bible tables; `direction-vocabulary.test.ts`
 * fails when an id has no label.
 */

import { t } from "../../i18n";
import type { VocabularyCategory } from "./vocabulary";

type Labels = Record<string, string>;

export const VOCABULARY_LABELS: Record<VocabularyCategory | "recipes", Labels> = {
  genres: {
    get "intimate-drama"() {
      return t("Intimate drama");
    },
    get thriller() {
      return t("Thriller");
    },
    get noir() {
      return t("Film noir");
    },
    get "scifi-grounded"() {
      return t("Grounded science fiction");
    },
    get "scifi-epic"() {
      return t("Epic science fiction");
    },
    get "fantasy-dark"() {
      return t("Dark fantasy");
    },
    get "fantasy-high"() {
      return t("High fantasy");
    },
    get horror() {
      return t("Horror");
    },
    get action() {
      return t("Action");
    },
    get comedy() {
      return t("Comedy");
    },
    get romance() {
      return t("Romance");
    },
    get western() {
      return t("Western");
    },
    get documentary() {
      return t("Documentary");
    },
    get product() {
      return t("Product commercial");
    },
    get "music-video"() {
      return t("Music video");
    },
    get "animation-3d"() {
      return t("3D animation");
    },
    get "animation-2d"() {
      return t("2D animation");
    },
  },
  moods: {
    get melancholic() {
      return t("Melancholic");
    },
    get tense() {
      return t("Tense");
    },
    get nostalgic() {
      return t("Nostalgic");
    },
    get contemplative() {
      return t("Contemplative");
    },
    get unsettling() {
      return t("Unsettling");
    },
    get euphoric() {
      return t("Euphoric");
    },
    get intimate() {
      return t("Intimate");
    },
    get epic() {
      return t("Epic");
    },
    get mysterious() {
      return t("Mysterious");
    },
    get urgent() {
      return t("Urgent");
    },
    get fatalistic() {
      return t("Fatalistic");
    },
    get confident() {
      return t("Confident");
    },
    get honest() {
      return t("Honest");
    },
    get whimsical() {
      return t("Whimsical");
    },
  },
  pacings: {
    get slow() {
      return t("Slow");
    },
    get steady() {
      return t("Steady");
    },
    get builds() {
      return t("Building tension");
    },
    get fast() {
      return t("Fast");
    },
    get rupture() {
      return t("Calm then burst");
    },
  },
  shotSizes: {
    get "extreme-wide"() {
      return t("Extreme wide shot");
    },
    get wide() {
      return t("Wide shot");
    },
    get full() {
      return t("Full shot");
    },
    get "medium-long"() {
      return t("Medium long shot");
    },
    get medium() {
      return t("Medium shot");
    },
    get "medium-close-up"() {
      return t("Medium close-up");
    },
    get "close-up"() {
      return t("Close-up");
    },
    get "extreme-close-up"() {
      return t("Extreme close-up");
    },
    get insert() {
      return t("Insert");
    },
    get "over-the-shoulder"() {
      return t("Over the shoulder");
    },
    get "two-shot"() {
      return t("Two-shot");
    },
    get pov() {
      return t("Point of view");
    },
  },
  lenses: {
    get "16mm"() {
      return t("16 mm ultra wide");
    },
    get "24mm"() {
      return t("24 mm wide angle");
    },
    get "35mm"() {
      return t("35 mm");
    },
    get "50mm"() {
      return t("50 mm");
    },
    get "85mm"() {
      return t("85 mm portrait");
    },
    get "135mm"() {
      return t("135 mm telephoto");
    },
    get macro() {
      return t("Macro");
    },
    get anamorphic() {
      return t("Anamorphic");
    },
  },
  depths: {
    get shallow() {
      return t("Shallow depth of field");
    },
    get deep() {
      return t("Deep focus");
    },
  },
  angles: {
    get "eye-level"() {
      return t("Eye level");
    },
    get low() {
      return t("Low angle");
    },
    get high() {
      return t("High angle");
    },
    get overhead() {
      return t("Overhead");
    },
    get dutch() {
      return t("Dutch angle");
    },
    get ground() {
      return t("Ground level");
    },
  },
  movements: {
    get static() {
      return t("Static");
    },
    get "push-in"() {
      return t("Push in");
    },
    get "pull-out"() {
      return t("Pull out");
    },
    get "pan-left"() {
      return t("Pan left");
    },
    get "pan-right"() {
      return t("Pan right");
    },
    get "tilt-up"() {
      return t("Tilt up");
    },
    get "tilt-down"() {
      return t("Tilt down");
    },
    get lateral() {
      return t("Lateral tracking");
    },
    get follow() {
      return t("Follow");
    },
    get leading() {
      return t("Leading");
    },
    get orbit() {
      return t("Orbit");
    },
    get crane() {
      return t("Crane up");
    },
    get handheld() {
      return t("Handheld");
    },
    get gimbal() {
      return t("Gimbal");
    },
    get drone() {
      return t("Drone");
    },
    get fpv() {
      return t("FPV");
    },
    get "dolly-zoom"() {
      return t("Dolly zoom");
    },
    get "rack-focus"() {
      return t("Rack focus");
    },
  },
  amplitudes: {
    get imperceptible() {
      return t("Barely perceptible");
    },
    get small() {
      return t("Small");
    },
    get medium() {
      return t("Moderate");
    },
    get large() {
      return t("Large");
    },
  },
  speeds: {
    get "very-slow"() {
      return t("Very slow");
    },
    get slow() {
      return t("Slow speed");
    },
    get steady() {
      return t("Steady speed");
    },
    get fast() {
      return t("Fast speed");
    },
  },
  transitions: {
    get "hard-cut"() {
      return t("Hard cut");
    },
    get dissolve() {
      return t("Dissolve");
    },
    get "fade-black"() {
      return t("Fade to black");
    },
    get "axial-cut"() {
      return t("Axial cut");
    },
    get "match-cut"() {
      return t("Match cut");
    },
    get continue() {
      return t("Direct continuation");
    },
  },
  tones: {
    get calm() {
      return t("Calm");
    },
    get whisper() {
      return t("Whispered");
    },
    get breaking() {
      return t("Holding back tears");
    },
    get cold() {
      return t("Cold");
    },
    get sharp() {
      return t("Sharp, commanding");
    },
    get tender() {
      return t("Tender");
    },
    get ironic() {
      return t("Ironic");
    },
    get anxious() {
      return t("Anxious");
    },
    get "contained-anger"() {
      return t("Contained anger");
    },
    get cheerful() {
      return t("Cheerful");
    },
    get tired() {
      return t("Exhausted");
    },
  },
  paces: {
    get slow() {
      return t("Slow delivery");
    },
    get measured() {
      return t("Measured delivery");
    },
    get natural() {
      return t("Natural delivery");
    },
    get rapid() {
      return t("Rapid delivery");
    },
  },
  ambiences: {
    get "quiet-interior"() {
      return t("Quiet interior");
    },
    get "old-house"() {
      return t("Old house");
    },
    get lake() {
      return t("Nature, lake");
    },
    get "city-night"() {
      return t("City at night");
    },
    get cafe() {
      return t("Café");
    },
    get forest() {
      return t("Forest");
    },
    get scifi() {
      return t("Machinery hum");
    },
    get tension() {
      return t("Low rumble");
    },
    get "rain-night"() {
      return t("Rain at night");
    },
    get "eerie-silence"() {
      return t("Eerie silence");
    },
    get "light-wind"() {
      return t("Light wind");
    },
    get studio() {
      return t("Subtle whoosh");
    },
    get real() {
      return t("Real ambience only");
    },
  },
  music: {
    get none() {
      return t("No music in the shot");
    },
    get discreet() {
      return t("Soft piano");
    },
    get strings() {
      return t("Strings");
    },
    get electronic() {
      return t("Electronic");
    },
    get percussion() {
      return t("Percussion");
    },
    get light() {
      return t("Light playful music");
    },
  },
  looks: {
    get "film-35"() {
      return t("35 mm film");
    },
    get "film-16"() {
      return t("16 mm film");
    },
    get digital() {
      return t("Digital cinema");
    },
    get "super-8"() {
      return t("Super 8");
    },
    get vhs() {
      return t("VHS");
    },
    get documentary() {
      return t("Documentary realism");
    },
    get commercial() {
      return t("Premium commercial");
    },
    get "black-white"() {
      return t("Black and white");
    },
    get "animation-3d"() {
      return t("3D animation look");
    },
    get "animation-2d"() {
      return t("2D animation look");
    },
    get "stop-motion"() {
      return t("Stop motion");
    },
  },
  palettes: {
    get "teal-amber"() {
      return t("Teal and amber");
    },
    get desaturated() {
      return t("Desaturated");
    },
    get warm() {
      return t("Warm tones");
    },
    get cold() {
      return t("Cold tones");
    },
    get "mono-accent"() {
      return t("Monochrome with one accent");
    },
    get pastel() {
      return t("Pastel");
    },
    get neon() {
      return t("Saturated neon");
    },
    get earth() {
      return t("Earth tones");
    },
  },
  lightSources: {
    get window() {
      return t("Window light");
    },
    get practical() {
      return t("Practical lamp");
    },
    get candle() {
      return t("Candlelight");
    },
    get overcast() {
      return t("Overcast daylight");
    },
    get streetlights() {
      return t("Streetlights");
    },
    get moonlight() {
      return t("Moonlight");
    },
    get neon() {
      return t("Neon signs");
    },
    get studio() {
      return t("Studio key light");
    },
    get sun() {
      return t("Direct sunlight");
    },
    get available() {
      return t("Available light");
    },
  },
  lightDirections: {
    get left() {
      return t("From camera left");
    },
    get right() {
      return t("From camera right");
    },
    get back() {
      return t("Backlight");
    },
    get top() {
      return t("Top light");
    },
    get under() {
      return t("Under light");
    },
  },
  lightQualities: {
    get soft() {
      return t("Soft diffused");
    },
    get hard() {
      return t("Hard direct");
    },
    get dappled() {
      return t("Dappled through leaves");
    },
  },
  lightMoments: {
    get golden() {
      return t("Golden hour");
    },
    get blue() {
      return t("Blue hour");
    },
    get midday() {
      return t("Harsh midday sun");
    },
    get night() {
      return t("Night");
    },
  },
  lightContrasts: {
    get "low-key"() {
      return t("Low key");
    },
    get "high-key"() {
      return t("High key");
    },
  },
  lightEffects: {
    get volumetric() {
      return t("Light shafts");
    },
    get rim() {
      return t("Rim light");
    },
    get flare() {
      return t("Lens flare");
    },
    get haze() {
      return t("Haze");
    },
    get blinds() {
      return t("Venetian blinds");
    },
  },
  textures: {
    get "fine-grain"() {
      return t("Fine grain");
    },
    get "heavy-grain"() {
      return t("Heavy grain");
    },
    get halation() {
      return t("Halation");
    },
    get softness() {
      return t("Lens softness");
    },
    get crisp() {
      return t("Crisp detail");
    },
    get "motion-blur"() {
      return t("Motion blur");
    },
  },
  negatives: {
    get subtitles() {
      return t("Subtitles");
    },
    get watermark() {
      return t("Watermark");
    },
    get logo() {
      return t("Logo");
    },
    get "extra-characters"() {
      return t("Extra characters");
    },
    get face() {
      return t("Face distortion");
    },
    get hands() {
      return t("Hands and limbs");
    },
    get cuts() {
      return t("Unwanted cuts");
    },
    get shake() {
      return t("Camera shake");
    },
    get costume() {
      return t("Costume changes");
    },
    get "live-action"() {
      return t("Photorealism");
    },
    get cartoon() {
      return t("Cartoon style");
    },
    get anachronism() {
      return t("Anachronisms");
    },
    get text() {
      return t("Readable background text");
    },
    get music() {
      return t("Unwanted music");
    },
    get lips() {
      return t("Lips moving");
    },
    get eyes() {
      return t("Strange eyes");
    },
    get "slow-motion"() {
      return t("Slow motion");
    },
  },
  recipes: {
    get "intimate-drama"() {
      return t("Intimate drama");
    },
    get thriller() {
      return t("Thriller");
    },
    get noir() {
      return t("Film noir");
    },
    get scifi() {
      return t("Science fiction");
    },
    get horror() {
      return t("Horror");
    },
    get action() {
      return t("Action");
    },
    get romance() {
      return t("Romance");
    },
    get product() {
      return t("Product commercial");
    },
    get documentary() {
      return t("Documentary");
    },
    get "animation-3d"() {
      return t("3D animation");
    },
  },
};

/** What a value does on screen, where the bible says so. */
export const VOCABULARY_EFFECTS: Partial<Record<VocabularyCategory, Labels>> = {
  genres: {
    get "intimate-drama"() {
      return t("Restrained acting, tight shots, natural light, little movement.");
    },
    get thriller() {
      return t("Tension, hard contrast, unstable frames, silences.");
    },
    get noir() {
      return t("Black and white or desaturated, hard shadows, rain, night.");
    },
    get "scifi-grounded"() {
      return t("Technological sets, cold light, human scale.");
    },
    get "scifi-epic"() {
      return t("Technological sets, cold light, vast scale.");
    },
    get "fantasy-dark"() {
      return t("Supernatural elements, heavy atmosphere.");
    },
    get "fantasy-high"() {
      return t("Supernatural elements, wonder, effects.");
    },
    get horror() {
      return t("Darkness, frames that hide, muffled sounds.");
    },
    get action() {
      return t("Fast movement, mobile camera, clean cuts.");
    },
    get comedy() {
      return t("Bright light, wide frames, timing.");
    },
    get romance() {
      return t("Warm light, soft focus, slow rhythm.");
    },
    get western() {
      return t("Wide open spaces, hard sun, dust.");
    },
    get documentary() {
      return t("Handheld camera, available light, imperfections.");
    },
    get product() {
      return t("Studio light, perfection, close-ups.");
    },
    get "music-video"() {
      return t("Rhythm on the beat, effects, poses.");
    },
    get "animation-3d"() {
      return t("Non-photorealistic render with soft volumes.");
    },
    get "animation-2d"() {
      return t("Hand-drawn look, flat colors and lines.");
    },
  },
  moods: {
    get melancholic() {
      return t("Low light, slow gestures, distant looks.");
    },
    get tense() {
      return t("Tight frames, micro-movements, silence.");
    },
    get nostalgic() {
      return t("Faded warm colors, grain.");
    },
    get contemplative() {
      return t("Long wide shots, little action.");
    },
    get unsettling() {
      return t("Shadows, off-screen space, muffled sounds.");
    },
    get euphoric() {
      return t("Bright light, movement, smiles.");
    },
    get intimate() {
      return t("Closeness, whispers, soft focus.");
    },
    get epic() {
      return t("Large scale, low angles, dramatic light.");
    },
    get mysterious() {
      return t("Mist, backlight, slow reveal.");
    },
    get urgent() {
      return t("Mobile camera, breath, quick cuts.");
    },
    get fatalistic() {
      return t("Resignation, heavy shadows.");
    },
    get confident() {
      return t("Polish, control, calm assurance.");
    },
    get honest() {
      return t("Observation without staging.");
    },
    get whimsical() {
      return t("Playful, warm, light-hearted.");
    },
  },
  pacings: {
    get slow() {
      return t("Long takes, measured gestures.");
    },
    get steady() {
      return t("The natural rhythm of a conversation.");
    },
    get builds() {
      return t("Speeds up toward a strong ending.");
    },
    get fast() {
      return t("Brisk energy.");
    },
    get rupture() {
      return t("Calm, then a sudden burst.");
    },
  },
  shotSizes: {
    get "extreme-wide"() {
      return t("The whole place, a tiny figure: to situate or isolate.");
    },
    get wide() {
      return t("A full figure in its setting: action, movement.");
    },
    get full() {
      return t("A full figure, closer: gestures, interactions.");
    },
    get "medium-long"() {
      return t("Mid-thigh up: two characters, westerns.");
    },
    get medium() {
      return t("Waist up: conversation.");
    },
    get "medium-close-up"() {
      return t("Chest up: dialogue, listening.");
    },
    get "close-up"() {
      return t("The face: emotion.");
    },
    get "extreme-close-up"() {
      return t("Eyes or a mouth: tension, key detail.");
    },
    get insert() {
      return t("An object, a hand: information, a clue.");
    },
    get "over-the-shoulder"() {
      return t("One speaker seen past the other: shot reverse shot.");
    },
    get "two-shot"() {
      return t("Two characters in frame: a relationship.");
    },
    get pov() {
      return t("What the character sees: immersion.");
    },
  },
  lenses: {
    get "16mm"() {
      return t("Exaggerated perspective: vast spaces, unease, immersive action.");
    },
    get "24mm"() {
      return t("Depth: establishing shots, sets.");
    },
    get "35mm"() {
      return t("Natural, slightly wide: the most cinematic.");
    },
    get "50mm"() {
      return t("Close to the human eye: neutral.");
    },
    get "85mm"() {
      return t("Flattering compression, soft background: portraits, dialogue.");
    },
    get "135mm"() {
      return t("Strong compression: isolate a face in a crowd.");
    },
    get macro() {
      return t("Extreme sharpness up close: details, products.");
    },
    get anamorphic() {
      return t("Oval bokeh, horizontal flares: premium cinema look.");
    },
  },
  depths: {
    get shallow() {
      return t("Soft background, isolates the subject.");
    },
    get deep() {
      return t("Everything sharp, keeps the context.");
    },
  },
  angles: {
    get "eye-level"() {
      return t("Neutral, equal.");
    },
    get low() {
      return t("Power, threat.");
    },
    get high() {
      return t("Vulnerability, loneliness.");
    },
    get overhead() {
      return t("Graphic, distant.");
    },
    get dutch() {
      return t("Imbalance, unease.");
    },
    get ground() {
      return t("Energy, scale.");
    },
  },
  movements: {
    get static() {
      return t("Observation, contained tension.");
    },
    get "push-in"() {
      return t("Move into the emotion.");
    },
    get "pull-out"() {
      return t("Reveal, isolate.");
    },
    get "pan-left"() {
      return t("Sweep, follow.");
    },
    get "pan-right"() {
      return t("Sweep, follow.");
    },
    get "tilt-up"() {
      return t("Reveal upward.");
    },
    get "tilt-down"() {
      return t("Reveal downward.");
    },
    get lateral() {
      return t("Accompany a movement.");
    },
    get follow() {
      return t("Stay with the character.");
    },
    get leading() {
      return t("The character walks toward us.");
    },
    get orbit() {
      return t("Showcase, reveal the set.");
    },
    get crane() {
      return t("A finale, scale.");
    },
    get handheld() {
      return t("Realism, urgency.");
    },
    get gimbal() {
      return t("Fluid through space.");
    },
    get drone() {
      return t("Flight, flyover.");
    },
    get fpv() {
      return t("Speed, diving flight.");
    },
    get "dolly-zoom"() {
      return t("Vertigo.");
    },
    get "rack-focus"() {
      return t("Shift the attention.");
    },
  },
  transitions: {
    get "hard-cut"() {
      return t("Standard, invisible.");
    },
    get dissolve() {
      return t("The passing of time, a memory.");
    },
    get "fade-black"() {
      return t("The end of a sequence.");
    },
    get "axial-cut"() {
      return t("An abrupt move closer.");
    },
    get "match-cut"() {
      return t("Fluid continuity.");
    },
    get continue() {
      return t("Carries on from the previous image.");
    },
  },
  music: {
    get none() {
      return t("Recommended: the score is laid in the montage, so the theme stays coherent.");
    },
  },
  looks: {
    get "film-35"() {
      return t("Fine grain, organic colors, soft highlights.");
    },
    get "film-16"() {
      return t("Marked grain, intimate, a little dated.");
    },
    get digital() {
      return t("Sharp, clean, wide dynamic range.");
    },
    get "super-8"() {
      return t("A memory, home footage.");
    },
    get vhs() {
      return t("Archive, flaws.");
    },
    get documentary() {
      return t("Available light, imperfections.");
    },
    get commercial() {
      return t("Sculpted light, perfection.");
    },
    get "black-white"() {
      return t("Contrast, timeless.");
    },
    get "animation-3d"() {
      return t("Soft volumes, stylized render.");
    },
    get "animation-2d"() {
      return t("Flat colors, lines.");
    },
    get "stop-motion"() {
      return t("Materials, slight jerkiness.");
    },
  },
  palettes: {
    get "teal-amber"() {
      return t("Modern cinema, warm against cold.");
    },
    get desaturated() {
      return t("Realism, gravity.");
    },
    get warm() {
      return t("Nostalgia, intimacy.");
    },
    get cold() {
      return t("Loneliness, distance.");
    },
    get "mono-accent"() {
      return t("One strong isolated color.");
    },
    get pastel() {
      return t("Softness, comedy.");
    },
    get neon() {
      return t("Urban night, energy.");
    },
    get earth() {
      return t("Western, rural.");
    },
  },
};
