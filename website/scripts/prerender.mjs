import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const template = await readFile("dist/index.html", "utf8");
  for (const path of ["/", "/downloads", "/privacy", "/security", "/help"]) {
    const body = renderToString(createElement(App, { initialPath: path }));
    const html = template.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    if (html === template) throw new Error("Prerender root is missing");
    const directory = join("dist", path.slice(1));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.html"), html);
  }
} finally {
  await server.close();
}
