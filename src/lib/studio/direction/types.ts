/**
 * A film's direction: the choices the prompt bible says are made once per
 * sequence and copied word for word into every shot of it. Genre, mood and
 * pacing open every prompt; look, palette, light and texture close it. A shot
 * changes its framing, its action and its line; it never changes these.
 *
 * Every value is an id of `vocabulary.json`. An id the vocabulary no longer
 * has writes nothing rather than failing, so an old project still compiles.
 */

export interface FilmLight {
  source?: string;
  direction?: string;
  quality?: string;
  moment?: string;
  contrast?: string;
  effects?: string[];
}

export interface ShotFraming {
  size?: string;
  lens?: string;
  depth?: string;
  angle?: string;
}

export interface CameraMove {
  kind?: string;
  amplitude?: string;
  speed?: string;
  /** Shot sizes the move starts and ends on, when the shot says so. */
  from?: string;
  to?: string;
}

/** Whether a line is spoken by the video model or laid in afterwards. */
export type DialogueMode = "auto" | "native" | "dubbed";

export interface FilmDirection {
  /** The recipe it was filled from, for the label only. */
  recipe?: string;
  genre?: string;
  /** At most two: a third dilutes the first two. */
  moods?: string[];
  /** A change of feeling across the shot, as two mood ids. */
  moodShift?: { from: string; to: string };
  pacing?: string;
  look?: string;
  palette?: string;
  light?: FilmLight;
  texture?: string;
  ambience?: string;
  /** Music inside the clips. Absent means none: the score is laid in the montage. */
  music?: string;
  /** Written in English, "1960s Paris". Set, it guards against modern objects. */
  era?: string;
  /** Risks to forbid on every shot, on top of the ones derived per shot. */
  negatives?: string[];
  /** The language the lines are spoken in, as a short code ("fr", "en"). */
  dialogueLanguage?: string;
  /** What a shot the script gave no camera for is framed with. */
  shotDefaults?: { framing?: ShotFraming; move?: CameraMove };
}

/** At most this many moods are written: the bible's rule. */
export const MAX_MOODS = 2;
