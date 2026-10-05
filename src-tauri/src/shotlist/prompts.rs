//! What a script is asked, and the one rule that keeps the app in charge.
//!
//! The model reads prose and returns structure. What it is deliberately never
//! asked for is a model id, a duration, an aspect ratio or a timestamp - the
//! things it cannot know, and the things that cost money when guessed. It
//! returns a motion class, who is in the shot, and the shot's camera, line and
//! sound as ids of the prompt bible's vocabulary (ADR-0074), and the app
//! resolves those against a catalogue it can actually see. Same division as the chapter
//! markers in `longform` (ADR-0027).

/// Bumped whenever the prompt or the shape changes, so a stored list says
/// which reading produced it.
pub const SHOTLIST_PROMPT_VERSION: &str = "shotlist-v4";

const MAP_INTRO: &str = "You break a script into the shots a short film is made of, the way a director's shot list is written for video generation models.

Return JSON only. No prose, no code fence. An object with four keys:

{\"language\": \"<the language the dialogue is spoken in, as a two-letter code: fr, en, es...>\",
 \"direction\": {\"genre\": \"<genre id>\", \"moods\": [\"<mood id>\"], \"pacing\": \"<pacing id>\"},
 \"cast\": [{\"name\": \"<exactly as the script spells it>\",
          \"kind\": \"character\" | \"location\" | \"prop\",
          \"traits\": \"<the frozen descriptor, see below>\"}],
 \"shots\": [ ... ]}

direction is your reading of the whole film: one genre, one or two moods (never more), one pacing.

cast lists everyone and everywhere the script names. traits is the frozen descriptor that will be pasted unchanged into every shot, so it describes only what is visible and must never drift. Write it in English, twenty-five to forty-five words, without the name, in this exact order:
- a person: age and build; face shape, eye color and one distinctive mark (a scar, a mole, a streak of hair) that tells them apart from anyone similar; hair length, color, texture and style; clothes from top to bottom, each with its material and color (\"navy wool coat\", never just \"coat\"); accessories with their side (\"silver ring on the right hand\"); optionally a habitual posture.
- an object: material, color, shape, condition, one unique detail.
- a place: period, materials, layout, and one fixed light source.
Never a feeling, a mood, a history or a role in the story: those change from shot to shot or are invisible. Never a vague adjective (beautiful, stylish, mysterious, elegant). If the script does not describe someone, invent something plain and specific and keep it.

shots is an array of shot objects, in order:

[{\"scene\": \"<short scene name, repeated for every shot in it>\",
  \"action\": \"<what happens, as physical events>\",
  \"size\": \"<shot size id>\", \"lens\": \"<lens id>\", \"depth\": \"<depth id>\", \"angle\": \"<angle id>\",
  \"movement\": \"<movement id>\", \"amplitude\": \"<amplitude id>\", \"speed\": \"<speed id>\",
  \"transition\": \"<transition id: how this shot joins the previous one>\",
  \"camera\": \"<a few words, only for what no id above can say, or empty>\",
  \"characters\": [\"<name>\"],
  \"location\": \"<name, or empty>\",
  \"dialogue\": \"<the line spoken on this shot, or empty>\",
  \"speaker\": \"<who says it, or empty>\",
  \"tone\": \"<tone id, or empty>\", \"pace\": \"<pace id, or empty>\",
  \"voiceover\": true | false,
  \"effects\": \"<the sounds synchronous with the action, in English, at most three, or empty>\",
  \"motion\": \"low\" | \"medium\" | \"high\",
  \"continues\": true | false}]

Rules, all of them binding:
- Use the names the script uses. Never rename a character or a place.
- action is one to three physical events in the order they happen, each a body part, a verb and a speed, in the present tense: \"her shoulders drop, she lowers her eyes and exhales slowly\", never \"she is sad\". Name the character in every event when two people share the frame. No feeling named, no gesture repeated faster than a person can (\"nods three times a second\").
- One camera movement per shot, with its amplitude and its speed. A static shot has no amplitude and no speed.
- Choose every id from the lists below, exactly as written. Leave a field empty rather than invent an id.
- motion is how much moves in frame: low is a face listening, medium is walking or a slow push, high is a chase or a fight.
- continues is true only when this shot carries straight on from the one before it, in the same place, with no cut in time. Its transition is then \"continue\".
- One shot is one continuous take of three to ten seconds, with one action and its reaction at most. Break a long paragraph into several shots.
- dialogue is what is actually spoken, with no character name prefix and no stage direction, kept in the script's language. One sentence of four to twelve words per shot: split a longer speech across shots. voiceover is true when the line is heard but not said on screen (a narration, a letter read, a voice on the phone).
- The tone belongs to the speaker, never to single words.
- Never output a duration, a timestamp, a model name, a resolution or an aspect ratio. They are not yours to choose.
- If a part of the script is not filmable (a title, a note to the reader), skip it rather than inventing a shot.
- The script may be in French or another language. Keep names and dialogue in the script's language; write traits and effects in English. A payment exchange, a musician entering, and a character reacting are filmable actions.
- If no action can be filmed, return {\"cast\":[],\"shots\":[]}.";

/// The system prompt, with every id the reader may use, read from the shared
/// vocabulary so the reader and the composer can never disagree.
pub fn map_system() -> String {
    let lists: Vec<String> = super::vocabulary::READER_CATEGORIES
        .iter()
        .map(|category| {
            format!(
                "- {}: {}",
                category,
                super::vocabulary::ids(category).join(", ")
            )
        })
        .collect();
    format!(
        "{MAP_INTRO}\n\nThe ids, by field (size: shotSizes, lens: lenses, depth: depths, angle: angles, movement: movements, amplitude: amplitudes, speed: speeds, transition: transitions, tone: tones, pace: paces, direction.genre: genres, direction.moods: moods, direction.pacing: pacings):\n{}\n- pacings: {}",
        lists.join("\n"),
        super::vocabulary::ids("pacings").join(", ")
    )
}

pub fn map_user_message(part_index: usize, part_count: usize, text: &str) -> String {
    if part_count <= 1 {
        return format!("The script:\n\n{text}");
    }
    format!(
        "Part {} of {} of the script. Continue the breakdown from where the previous part left off, and do not repeat shots you can see were already covered.\n\n{text}",
        part_index + 1,
        part_count
    )
}
