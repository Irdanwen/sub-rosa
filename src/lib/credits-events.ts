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

/**
 * A key just made from the account starts at zero, and the screen that made
 * it (the first run, the key gate) goes away as soon as the engine starts on
 * it. The request to buy the first credits is left here for the shell, which
 * shows the sheet once when it mounts. sessionStorage: a relaunch is a new
 * decision, not a leftover.
 */
const FIRST_PURCHASE_KEY = "subrosa:first-purchase-pending";

export function markFirstPurchasePending() {
  try {
    sessionStorage.setItem(FIRST_PURCHASE_KEY, "1");
  } catch {
    // Without storage the shell simply does not open the sheet by itself.
  }
}

/** True once: reading it clears it. */
export function takeFirstPurchasePending() {
  try {
    const pending = sessionStorage.getItem(FIRST_PURCHASE_KEY) === "1";
    sessionStorage.removeItem(FIRST_PURCHASE_KEY);
    return pending;
  } catch {
    return false;
  }
}
