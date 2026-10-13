#!/usr/bin/env node
// Every public page of a production build, under the production headers.
//
// The dev server sends no Content-Security-Policy, so a style attribute, an
// inline script or a Trusted Types sink only fails once deployed. This
// serves `dist` with the site-wide block of `dist/_headers`, opens each URL
// of `dist/sitemap.xml` in a headless Chromium, and reports what the console
// refused, what threw, and the accessibility basics a page must keep: one
// h1, the right lang, every image described, no unnamed link or button, no
// duplicate id. Exit code 1 when anything is found.
//
// Usage: pnpm --filter @subrosa/website build
//        node website/scripts/csp-sweep.mjs [--only=/fr] [--dist=website/dist]
// Chromium: $CHROME, else the newest Playwright headless shell in the cache.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const dist = resolve(args.dist ?? "website/dist");
const only = args.only ?? "";

function siteHeaders() {
  const lines = readFileSync(join(dist, "_headers"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  const headers = {};
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break;
    const [name, ...value] = line.trim().split(":");
    if (name && !name.startsWith("!")) headers[name] = value.join(":").trim();
  }
  return headers;
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

function serve(headers) {
  return new Promise((done) => {
    const server = http.createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
      let file = join(dist, path);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) file = join(dist, "index.html");
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
      response.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

function chromium() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const alt = join(homedir(), ".cache/ms-playwright");
  for (const root of [cache, alt]) {
    if (!existsSync(root)) continue;
    const shells = readdirSync(root)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const shell of shells) {
      for (const dir of readdirSync(join(root, shell))) {
        const binary = join(root, shell, dir, "chrome-headless-shell");
        if (existsSync(binary)) return binary;
      }
    }
  }
  throw new Error("No Chromium found: set CHROME to a headless Chromium binary.");
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function browser() {
  const port = 9600 + Math.floor(Math.random() * 300);
  const proc = spawn(
    chromium(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      `--user-data-dir=${join(tmpdir(), `csp-sweep-${port}`)}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let target;
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((entry) => entry.type === "page");
    } catch {}
    if (!target) await sleep(150);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done));
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) events.push(message);
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      const next = ++id;
      pending.set(next, done);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  return { proc, socket, send, events };
}

const AUDIT = `(() => {
  const found = [];
  const h1 = document.querySelectorAll("main h1").length;
  if (h1 !== 1) found.push(h1 + " h1 in main");
  for (const img of document.querySelectorAll("img"))
    if (!img.hasAttribute("alt")) found.push("image without alt: " + img.getAttribute("src"));
  for (const el of document.querySelectorAll("a[href], button")) {
    const name = (el.getAttribute("aria-label") || el.textContent || el.querySelector("img")?.alt || "").trim();
    if (!name) found.push("unnamed " + el.tagName.toLowerCase() + ": " + (el.getAttribute("href") || el.className));
  }
  const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
  for (const dup of new Set(ids.filter((value, index) => ids.indexOf(value) !== index)))
    found.push("duplicate id: " + dup);
  for (const el of document.querySelectorAll("[style]"))
    found.push("style attribute on " + el.tagName.toLowerCase());
  return { lang: document.documentElement.lang, found };
})()`;

const headers = siteHeaders();
const server = await serve(headers);
const local = `http://127.0.0.1:${server.address().port}`;
const xml = readFileSync(join(dist, "sitemap.xml"), "utf8");
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((match) => new URL(match[1]))
  .map((url) => `${local}${url.pathname}`)
  .filter((url) => new URL(url).pathname.startsWith(only));

const { proc, socket, send, events } = await browser();
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");

const problems = [];
for (const url of urls) {
  events.length = 0;
  await send("Page.navigate", { url });
  for (let waited = 0; waited < 8000; waited += 100) {
    if (events.some((event) => event.method === "Page.loadEventFired")) break;
    await sleep(100);
  }
  await sleep(350);
  const page = new URL(url).pathname;
  const expected = page.match(/^\/(fr|de|it|es|pt-br)(\/|$)/)?.[1] ?? "en";
  for (const event of events) {
    if (event.method === "Log.entryAdded" && event.params.entry.level === "error")
      problems.push(`${page}  console: ${event.params.entry.text}`);
    if (event.method === "Runtime.exceptionThrown")
      problems.push(
        `${page}  threw: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`,
      );
    if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      problems.push(
        `${page}  console.error: ${event.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`,
      );
  }
  const audit = (await send("Runtime.evaluate", { expression: AUDIT, returnByValue: true })).result
    ?.result?.value;
  if (audit) {
    if (audit.lang.toLowerCase() !== expected)
      problems.push(`${page}  lang="${audit.lang}", expected ${expected}`);
    for (const finding of audit.found) problems.push(`${page}  ${finding}`);
  }
}

socket.close();
proc.kill();
server.close();
console.log(`${urls.length} pages swept under the production policy.`);
for (const problem of problems) console.log(problem);
process.exit(problems.length ? 1 : 0);
