/**
 * Two window events, kept in a module with no imports so anything can use
 * them without pulling the purchase code in: "open the Add credits sheet",
 * and "the balance may have moved, ask again".
 */
const ADD_CREDITS_EVENT = "subrosa:add-credits";
const CREDITS_CHANGED_EVENT = "subrosa:credits-changed";

/** Opens the Add credits sheet, wherever the shell mounted it. */
export function requestAddCredits() {
  window.dispatchEvent(new Event(ADD_CREDITS_EVENT));
}

export function onAddCreditsRequested(handler: () => void) {
  window.addEventListener(ADD_CREDITS_EVENT, handler);
  return () => window.removeEventListener(ADD_CREDITS_EVENT, handler);
}

/** The balance may have moved (a payment landed, the pay page sent the person
 * back): every balance on screen asks again. */
export function notifyCreditsChanged() {
  window.dispatchEvent(new Event(CREDITS_CHANGED_EVENT));
}

export function onCreditsChanged(handler: () => void) {
  window.addEventListener(CREDITS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CREDITS_CHANGED_EVENT, handler);
}
