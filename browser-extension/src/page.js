/**
 * Runs inside the page, once, on the click that asked for it (`activeTab`
 * plus `scripting.executeScript`). It must be self-contained: the browser
 * serialises the function and nothing it closes over comes along.
 */
export function readPage() {
  const selection = String(globalThis.getSelection?.() ?? "").trim();
  const candidates = [document.querySelector("article"), document.querySelector("main")];
  const main = candidates.find((node) => (node?.innerText ?? "").trim().length > 500);
  const root = main ?? document.body;
  const text = String(root?.innerText ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 60_000),
    selection: selection.slice(0, 20_000),
  };
}
