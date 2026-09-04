# Modal surfaces use `useModalFocus`

## Rule

Anything that opens over the page and expects the keyboard to stay with it
(a dialog, a sheet, the command palette, a panel with `role="dialog"`)
gets its keyboard and focus behaviour from `useModalFocus` in
`src/lib/modal-focus.ts`, and from nowhere else. No component adds its own
Escape listener, its own Tab trap, or its own "focus the first button on
mount" effect.

## Why

The four rules of a modal surface (focus moves in, Tab stays in, Escape
closes, focus goes back) were copied into each surface, and every copy
was a subset. The palette had Escape but let Tab leave; a panel had a
focus-on-mount effect but no Escape; two surfaces open at once both
closed on one Escape. One hook holds the four rules and a stack that says
which surface is on top, so the behaviour is the same everywhere and a
fix lands everywhere.

## How to apply

- Give the surface a ref and `tabIndex={-1}`, and call
  `useModalFocus(ref, { open, onClose, initialFocusSelector?, lockScroll? })`.
- Do not add `onKeyDown` handlers for Escape or Tab on the surface, and do
  not call `.focus()` in a mount effect; pass `initialFocusSelector` if the
  first focusable is not the right target.
- A surface that is conditionally rendered passes `open`; one that is
  mounted only while open can omit it.

## Exceptions

- A non-modal popover (a hover tip, a menu that closes on blur) is not a
  modal surface and may handle its own keys.
- A panel that lets you keep working behind it (the rewrite proposal over
  the editor, the raw trace drawer beside the chat) is not modal either:
  trapping Tab there would take the keyboard away from the work.
- The note editor's own key handling inside a modal is unaffected: the hook
  listens in the capture phase for Escape and Tab only.
