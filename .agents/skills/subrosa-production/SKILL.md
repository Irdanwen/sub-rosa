---
name: subrosa-production
description: How Sub Rosa makes a film locally - the bible, the shot list, the prompt discipline these video models need, and what costs money. Read it before your first film, or when a shot comes back looking like a different character.
---

# Making a film in Sub Rosa

Films are produced by the app, on this machine, out of the user's own notes.
There is no remote studio and no separate account.

Three things exist, and they are separate on purpose:

- **The bible** is who and where. It persists across every film.
- **The shot list** is one note read as shots. It belongs to that note.
- **The workflow** is the production. It spends money, and only the user
  starts it.

You can build the first two. You cannot start the third.

## What you can and cannot do

You have two tools, `bible` and `shots`. Between them you can name a cast, give
them traits and references, and turn a script into a shot list. What happens
next is in the **Studio's film project** (Studio > Project): the person sets the
film's direction, checks each shot's composed prompt, and sees the figure
before anything is spent. Say that plainly. Do not imply you are about
to make the film.

## The bible is what stops a character drifting

Nothing carries over between separately generated clips. Shot twelve knows
nothing about shot one. A character stays the same character only because two
things are repeated on *every* shot: their reference images, in the same order,
and their invariant traits, restated in the prompt.

So a bible entry is worth more than it looks:

- `name` is what the script calls them. Use the script's spelling exactly, or
  the shot list will not match them up.
- `traits` is the **frozen descriptor**, pasted unchanged into every shot:
  25 to 45 English words, without the name, in this order for a person - age
  and build; face and one distinctive mark; hair; clothes top to bottom, each
  with material and color; accessories with their side. "a 30-year-old woman,
  slim build, oval face, green eyes, small scar above the left eyebrow,
  shoulder-length dark brown wavy hair worn loose, navy wool coat, mustard
  knitted scarf, silver ring on the right hand" is right. A place: period,
  materials, layout, one fixed light source. An object: material, color, shape,
  condition, one unique detail. Never a feeling, a backstory or a vague
  adjective (beautiful, mysterious): they change nothing on screen.
- References are attached in **roles**, and the order matters. `portrait` first
  is the identity the model holds, then `outfit` (a full body view; it takes the
  profile's place), then the location's `wide`, `medium`, `detail`, a prop's
  `detail`, and one `look` image for color and light only. A `voice` reference
  is a speech artifact: a line the video model speaks itself follows its timbre,
  and a dubbed line is spoken in it.

A location is an entry too, and so is a prop that has to look like itself, and
so is the overall `look`.

## Reading a script

`shots plan` first, always, and tell the user what it will take. Then
`shots build`, which runs in the background and survives the app being closed;
`shots read` says where it got to.

What comes back per shot is deliberately incomplete. There is no model, no
duration, no aspect ratio and no timestamp in it, because a language model
cannot know a catalogue it has never seen and a guess there gets billed. The
app resolves those. What the shot list does carry:

- `motion`: `low`, `medium` or `high`. This is what picks the duration - a face
  listening does not need eight seconds, a chase does not read in three.
- `continues`: true only when the shot carries straight on from the one before
  it, same place, no cut in time. This is what makes the app chain the shot from
  the previous one's handoff frame, which is what makes the seam invisible.
- `characters` and `location`, by name, so the bible can be matched in.

If the shot list gets a name wrong, fix the note or the bible entry so they
agree, and read it again.

## Prompt discipline

The app writes every shot's prompt itself, from the prompt bible's blocks, in
this order (ADR-0074): **[OVERALL]** genre, at most two moods, the seconds the
app resolved, pacing, "Single continuous shot."; **[REFERENCES]** one sentence
per image saying what it is for ("Image 1 is Léa: face and hair."); **[SUBJECT]**
the frozen descriptors; **[SHOT]** size, lens, angle, then **one** camera
movement with its amplitude and its speed, then the action as one to three
physical events (a body part, a verb, a speed, never a named feeling);
**[DIALOGUE]** the line or "No dialogue."; **[SOUND]** effects, ambience, no
music; **[STYLE]** look, palette, light (source, direction, quality), texture;
**[NEGATIVE]** only the risks this shot runs. The film's genre, moods and style
are identical on every shot.

Each family is written its own way (`src/lib/studio/direction/profiles.json`):
labels or prose, its own word budget (Seedance 2.0: sixty), a time range on the
shot label only where the family reads it. Kling never gets a number: its own
`shot 1, 3s` notation cuts to a new shot. A Seedance reference prompt opens with
"Refer to <Image 1> for ...", because that opening routes the request. Mentions
are `<Image 1>` for Seedance, `@Element1` and `@Image1` for Kling, "Image 1"
elsewhere. One project shot is one continuous take: never write a cut or
"Lens switch."; transitions are fades in the montage.

A line is spoken by the video model only in a language its family speaks
(MiniMax H3 speaks French; the others English at most); otherwise it is dubbed
and the prompt shows the speaker speaking without quoting the line.

If you must write a prompt by hand, keep that order and those rules. "Improve
with AI" improves the composed prompt and keeps its blocks.

## What costs money, and what does not

Free: the bible, planning, compiling, changing your mind, and the timeline
export.

Paid: reading a script (a handful of chat calls), and then every shot, every
line of dialogue and the score. Video is by far the most expensive thing in the
app - a single five-second shot is roughly the price of a hundred chat turns.

The compile step refuses outright to build a production that costs more than
the ceiling the user set. That is not the confirmation step, it is in front of
it. If the user wants more film than the ceiling allows, they raise the ceiling
deliberately or cut shots.

## When something looks wrong

- **A face changed between shots**: the character is probably not in the bible,
  or the script spells their name differently. Check both.
- **The cut jumps**: the shot was not marked `continues`, so it was rendered
  from scratch instead of from the previous frame.
- **A render failed on the payment rail or on capacity**: those come and go in
  windows. The run waits them out on its own for about ten minutes before
  giving up. Tell the user to wait rather than starting over, which pays twice.
