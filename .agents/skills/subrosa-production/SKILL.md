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
next is in **Studio > Workflows > From a script**, where the user sees the
figure before anything is spent. Say that plainly. Do not imply you are about
to make the film.

## The bible is what stops a character drifting

Nothing carries over between separately generated clips. Shot twelve knows
nothing about shot one. A character stays the same character only because two
things are repeated on *every* shot: their reference images, in the same order,
and their invariant traits, restated in the prompt.

So a bible entry is worth more than it looks:

- `name` is what the script calls them. Use the script's spelling exactly, or
  the shot list will not match them up.
- `traits` is what must not drift, and nothing else. "Green wool coat, scar
  over the left brow, a head shorter than Kell" is right. Their backstory is
  not: it costs prompt budget and changes nothing on screen.
- References are attached in **roles**, and the order matters. `portrait` first
  is the identity the model holds. Then `profile`, then the location's `wide`,
  `medium`, `detail`. A `voice` reference is a speech artifact the character's
  lines are then spoken in.

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

## Prompt discipline, if you are writing one by hand

These video models drop clauses past roughly sixty words, and you do not get to
choose which. Structure: subject, action, camera, style, constraints. Restate
the invariant traits. Reference the images the way the family reads them
(`<Image 1>` for seedance, plain "image 1" elsewhere).

Adjacent beats in one place go in **one** generation separated by
`Lens switch.` - one render holds the lighting and the geography across them in
a way two renders cannot, however carefully the second one is prompted.

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
