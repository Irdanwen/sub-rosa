/**
 * The line under a note's title in a list, read as text rather than as the
 * markdown it is stored in.
 *
 * The list hands over the first 140 characters of the note's body. A generated
 * note opens with its own title as a heading, so the row used to read
 * "Planchette d'essai" over "# Planchette d'essai – exécution…": the title
 * twice, with the syntax showing. This drops the markup and, when the body
 * opens by restating the title, drops that line too.
 */
export function readablePreview(preview: string, title: string): string {
  const wanted = comparable(title);
  const lines: string[] = [];
  let inFence = false;
  for (const raw of preview.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith("|") || /^([-*_])\1{2,}$/.test(line)) continue;
    const text = inline(line.replace(/^#{1,6}\s+/, "").replace(/^([-*+]|\d+[.)]|>)\s+/, ""));
    if (!text) continue;
    if (lines.length === 0 && wanted && comparable(text) === wanted) continue;
    lines.push(text);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function inline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
}

function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\s.:;!?…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}
