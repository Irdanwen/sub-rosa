//! What a script is asked, and the one rule that keeps the app in charge.
//!
//! The model reads prose and returns structure. What it is deliberately never
//! asked for is a model id, a duration, an aspect ratio or a timestamp - the
//! things it cannot know, and the things that cost money when guessed. It
//! returns a motion class and who is in the shot, and the app resolves those
//! against a catalogue it can actually see. Same division as the chapter
//! markers in `longform` (ADR-0027).

/// Bumped whenever the prompt or the shape changes, so a stored list says
/// which reading produced it.
pub const SHOTLIST_PROMPT_VERSION: &str = "shotlist-v2";

pub const MAP_SYSTEM: &str = "You break a script into the shots a short film is made of.

Return JSON only. No prose, no code fence. An object with two keys:

{\"cast\": [{\"name\": \"<exactly as the script spells it>\",
          \"kind\": \"character\" | \"location\" | \"prop\",
          \"traits\": \"<what must not change between shots>\"}],
 \"shots\": [ ... ]}

cast lists everyone and everywhere the script names. traits is appearance only,
and only what has to stay the same: build, age, hair, wardrobe, distinguishing
marks for a person - materials, light, time of day for a place. Never their
history, their feelings or their role in the story: those cost words on every
shot and change nothing on screen. Ten to twenty words. If the script does not
describe them, invent something plain and specific and stick to it.

shots is an array of shot objects, in order:

[{\"scene\": \"<short scene name, repeated for every shot in it>\",
  \"action\": \"<what happens, one sentence, present tense>\",
  \"camera\": \"<framing and movement, a few words>\",
  \"characters\": [\"<name>\"],
  \"location\": \"<name, or empty>\",
  \"dialogue\": \"<the line spoken on this shot, or empty>\",
  \"speaker\": \"<who says it, or empty>\",
  \"motion\": \"low\" | \"medium\" | \"high\",
  \"continues\": true | false}]

Rules, all of them binding:
- Use the names the script uses. Never rename a character or a place.
- motion is how much moves in frame: low is a face listening, medium is walking or a slow push, high is a chase or a fight.
- continues is true only when this shot carries straight on from the one before it, in the same place, with no cut in time.
- One shot is one continuous take of a few seconds. Break a long paragraph into several.
- dialogue is what is actually spoken, with no character name prefix and no stage direction.
- Never output a duration, a timestamp, a model name, a resolution or an aspect ratio. They are not yours to choose.
- If a part of the script is not filmable (a title, a note to the reader), skip it rather than inventing a shot.";

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
