---
status: accepted
date: 2026-10-07
---

# Protected mode is a local PIN guard, enforced where requests leave

## Context

The parity matrix (ADR-0078) left parental controls open. The vendor's version
links a parent account to a teen account on its servers. Sub Rosa has no such
server: inference goes from the device to Carpe Diem with the user's own key,
the optional account service stores ciphertext only (ADR-0049), and nothing
can impose a policy on a device from outside. What a parent can reasonably ask
of this app is narrower: hand a device to a child, or share one, and know that
the obvious paths to adult content are closed until someone who knows a PIN
opens them again.

Three paths matter. The model catalog includes adult and uncensored families
(Venice's `venice-uncensored`, the Lustify image models, uncensored edit and
chat variants). The Studio sends `safe_mode: false` on every picture request,
so the provider never blurs adult output. And the chat prompts carry no rule
about the reader's age.

## Decision

1. **One switch, behind a PIN, on this device.** Settings › Privacy carries a
   "Protected mode" card on both shells (the phone's Privacy screen renders the
   same section). Turning it on sets a PIN of four to six digits; turning it
   off takes that PIN and forgets it. The settings file
   (`protected-mode.json`, next to the other settings files) keeps a salted
   scrypt hash (N = 2^15, r = 8, p = 1), never the PIN; checks compare in
   constant time; five wrong PINs in a row lock the next try for 30 seconds,
   in process. The webview learns only whether it is on.
2. **The guards are Rust's, at the points requests leave, not the webview's.**
   - The media proxy (`carpe_diem::media::send`, which every Studio,
     workflow, assistant and durable job request goes through) refuses an
     adult model and rewrites an image generate or edit body to
     `safe_mode: true`, whatever the webview sent.
   - The chat proxy (`june_api::proxy_agent_chat_completions`, every phone
     turn and every side call) refuses an adult model, and so does the
     command that sets the chat default (`set_venice_model`). The stored
     default reads as the built-in one while it is adult, and is reset to it
     when protected mode turns on. A phone chat's own model is checked when
     its turn leaves, not when it is set.
   - Both catalogs (`carpe_diem_media_catalog`, `list_venice_models`) leave
     adult families out, so every picker (desktop chat, phone chat, Studio,
     assistants, settings) loses them without its own code. The media catalog
     says it was filtered, so the webview also drops the unlisted passthrough
     edit models it adds itself.
3. **"Adult" is one predicate, by name, mirrored once.** The catalog has no
   adult flag. `protected_mode::guards::is_adult_model` (and
   `src/lib/adult-models.ts`, kept identical) matches `uncensored`, `lustify`,
   `nsfw`, `heretic` and `abliterat` in a model's id, name or traits (Venice
   tags its most permissive models `most_uncensored`). A family that is
   permissive without saying so is not caught by name; the image safe mode
   still applies to it.
4. **The prompt block rides the ADR-0081 seams.** A protective instruction
   (general audience, no sexual, graphic, hateful or dangerous content even in
   role play, care and a trusted adult or helpline for someone in distress)
   leads the desktop SOUL's personal section, rewritten in place when the
   switch changes, and is appended to the phone's system prompt after it is
   chosen, so a custom assistant on the phone carries it too.
5. **The protected settings are the switch itself.** Nothing else undoes a
   guard: the safe mode and the model filter are consequences of the switch,
   not settings of their own, so the PIN guards turning protected mode off and
   nothing more.

## Consequences

- It stops casual change in the app, and only that. Someone who can edit the
  app's files, reinstall the app, or use another app with the same Carpe Diem
  key removes it. A PIN of four to six digits cannot resist an offline guess
  against its hash by someone who can read the file; the hash keeps it from
  being read at a glance. The settings copy says so in plain words.
- The desktop agent runtime switches a chat's model over its own gateway
  from the webview; there the guard is the filtered picker and the sanitised
  default, not a Rust refusal. A desktop chat already open keeps the SOUL it
  began with (ADR-0081); the next chat reads the block.
- Video and audio have no provider safe mode we send. They get the model
  filter and the provider's own moderation, nothing more.
- A phone chat bound to an adult model before the switch fails its next turn
  with "Protected mode blocks this model. Choose another one." rather than
  silently changing model.
- The switch stays on the device: settings files have no sync codec
  (ADR-0081), and a policy one device could push to another would need a
  trust model this product does not have.

## Alternatives rejected

- **Filtering in each picker.** Six pickers on two shells, plus remembered
  choices and crafted calls; one filter at the two catalogs and one refusal at
  each exit cover them all.
- **A Studio safe mode toggle the PIN guards.** It would be a second switch
  meaning the same thing; forcing it from the one switch is simpler and
  cannot drift.
- **Storing the PIN in the OS keychain.** It would hide the hash better, but
  the guard is only as strong as the file that says it is on, which a
  keychain does not protect. The honest boundary is the same either way.
- **A server-side policy through the account service.** Accounts store
  identity and ciphertext (ADR-0049); a policy service would be the first
  server that decides what a device may do.
