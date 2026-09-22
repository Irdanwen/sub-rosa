/**
 * Where a phone sheet renders: the shell, not the spot it was opened from.
 *
 * Inside a scrolling panel a fixed layer can end up positioned against a
 * transformed ancestor (the stack transitions animate `transform`). The shell
 * rather than `body`, so the phone's own rules still reach what the sheet
 * holds: the 16px field floor that keeps iOS from zooming lives under
 * `.mobile-shell`.
 */
export function sheetHost(): Element {
  return document.querySelector(".mobile-shell") ?? document.body;
}
