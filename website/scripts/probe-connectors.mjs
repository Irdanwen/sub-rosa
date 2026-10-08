// Which catalog connectors a browser tab can reach (ADR-0092, web client).
//
// A tab speaks to an MCP server and to its authorization server with `fetch`,
// so each of them has to answer the site's origin with CORS: the MCP endpoint
// (a JSON `POST`, so a preflight), its protected resource metadata, the
// authorization server's metadata, dynamic registration and the token
// endpoint. A server that refuses one of them cannot be used from the web
// client at all, and the honest outcome is to say so: nothing is relayed
// through the account service.
//
// This script loads a blank page on the site's real origin in headless
// Chromium (Playwright routes that one address to a stub, everything else
// goes to the network), runs each step from the page, and writes what it saw
// to `website/src/client/connectors/web-availability.json`. Nothing it sends
// creates anything: registration is asked its preflight and sent JSON that
// does not parse (some servers register a client from any body that does,
// even an empty one), and the token request carries a code that does not
// exist. A registration endpoint counts as reachable when either answers the
// site's origin: some answer their errors without CORS headers.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> \
//   CHROMIUM=<path to a Chromium or headless shell> \
//   node website/scripts/probe-connectors.mjs
//
// Defaults: the scratch install the WP20b work used, and Playwright's cached
// headless shell 1234. Playwright is not a dependency of the repository.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ORIGIN = process.env.PROBE_ORIGIN ?? "https://subrosa.furetier.com";
const core =
  process.env.PLAYWRIGHT_CORE ??
  "/private/tmp/claude-501/-Users-morganmagalhaes-Documents-Codage-Sub-Rosa/95d0edc6-d51f-4935-ab62-32eb412237d2/scratchpad/pw/node_modules/playwright-core";
const chromium =
  process.env.CHROMIUM ??
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );

const exported = JSON.parse(
  readFileSync(join(root, "packages/chat-core/web/connectors.json"), "utf8"),
);

/** The preflight a `POST` with JSON needs, asked with curl as the operator
 * would check a CORS deployment, for the record. */
function preflight(
  url,
  headers = "content-type,mcp-protocol-version,authorization,mcp-session-id",
) {
  try {
    const out = execFileSync(
      "curl",
      [
        "-si",
        "-m",
        "15",
        "-X",
        "OPTIONS",
        url,
        "-H",
        `Origin: ${ORIGIN}`,
        "-H",
        "Access-Control-Request-Method: POST",
        "-H",
        `Access-Control-Request-Headers: ${headers}`,
      ],
      { encoding: "utf8" },
    );
    const status = Number(/^HTTP\/\S+ (\d+)/m.exec(out)?.[1] ?? 0);
    const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(out)?.[1]?.trim() ?? null;
    return {
      status,
      allowOrigin: header("access-control-allow-origin"),
      allowHeaders: header("access-control-allow-headers"),
      exposeHeaders: header("access-control-expose-headers"),
    };
  } catch {
    return { status: 0, allowOrigin: null, allowHeaders: null, exposeHeaders: null };
  }
}

/** Runs in the page: every step a web client takes, as far as it can go. */
async function probe(entry) {
  const step = async (url, init) => {
    try {
      const response = await fetch(url, { ...init, credentials: "omit", redirect: "follow" });
      let body = null;
      try {
        body = await response.clone().json();
      } catch {
        body = null;
      }
      return {
        ok: true,
        status: response.status,
        wwwAuthenticate: response.headers.get("www-authenticate"),
        sessionId: response.headers.get("mcp-session-id"),
        body,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ? error.message : error) };
    }
  };
  const result = { id: entry.id, url: entry.url, auth: entry.auth };
  result.mcp = await step(entry.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Sub Rosa", version: "probe" },
      },
    }),
  });
  if (result.mcp.ok) {
    result.mcp.refusal =
      result.mcp.status === 403
        ? String(result.mcp.body?.error?.message ?? "").slice(0, 120)
        : null;
    delete result.mcp.body;
  }
  if (entry.auth === "none") return result;
  const endpoint = new URL(entry.url);
  const path = endpoint.pathname.replace(/\/$/, "");
  const hint = /resource_metadata="?([^",\s]+)"?/.exec(result.mcp.wwwAuthenticate ?? "")?.[1];
  const candidates = [
    ...(hint ? [hint] : []),
    ...(path ? [`${endpoint.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${endpoint.origin}/.well-known/oauth-protected-resource`,
  ];
  let issuers = [];
  result.resourceMetadata = [];
  for (const candidate of candidates) {
    const got = await step(candidate, { headers: { Accept: "application/json" } });
    result.resourceMetadata.push({ url: candidate, ok: got.ok, status: got.status ?? null });
    if (got.ok && got.status === 200 && got.body && Array.isArray(got.body.authorization_servers)) {
      issuers = got.body.authorization_servers;
      break;
    }
  }
  if (!issuers.length) issuers = [endpoint.origin];
  result.issuer = issuers[0];
  const issuer = new URL(issuers[0]);
  const ipath = issuer.pathname.replace(/\/$/, "");
  const asCandidates = ipath
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server${ipath}`,
        `${issuer.origin}/.well-known/openid-configuration${ipath}`,
        `${issuer.origin}${ipath}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ];
  let metadata = null;
  result.authServerMetadata = [];
  for (const candidate of asCandidates) {
    const got = await step(candidate, { headers: { Accept: "application/json" } });
    result.authServerMetadata.push({ url: candidate, ok: got.ok, status: got.status ?? null });
    if (got.ok && got.status === 200 && got.body?.token_endpoint) {
      metadata = got.body;
      break;
    }
  }
  if (!metadata) return result;
  result.endpoints = {
    authorization: metadata.authorization_endpoint ?? null,
    token: metadata.token_endpoint ?? null,
    registration: metadata.registration_endpoint ?? null,
  };
  result.s256 = (metadata.code_challenge_methods_supported ?? []).includes("S256");
  if (metadata.registration_endpoint) {
    // Unparseable JSON: no server can register a client from it, and a
    // readable refusal still proves the endpoint answers this origin.
    const got = await step(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{",
    });
    result.registrationFromTab = { ok: got.ok, status: got.status ?? null };
  }
  if (metadata.token_endpoint) {
    const got = await step(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: `grant_type=authorization_code&code=subrosa-probe-not-a-code&client_id=subrosa-probe&redirect_uri=${encodeURIComponent(`${ORIGIN}/app`)}&code_verifier=subrosa-probe-not-a-verifier-0000000000000000`,
    });
    result.token = { ok: got.ok, status: got.status ?? null, error: got.error ?? null };
  }
  return result;
}

/** Whether a registration endpoint admits the site's origin, from its
 * preflight alone. */
function registrationAdmits(url) {
  if (!url) return null;
  const answer = preflight(url, "content-type");
  return {
    ...answer,
    ok:
      answer.status >= 200 &&
      answer.status < 300 &&
      (answer.allowOrigin === "*" || answer.allowOrigin === ORIGIN),
  };
}

/** Whether a tab can use the server, and if not, the first step that refused. */
function verdict(found) {
  const refused = (what) => ({ web: false, reason: what });
  if (!found.mcp.ok) return refused("mcp_cors");
  // A server that checks the Origin header (the protocol's guard against DNS
  // rebinding) and admits no web origin.
  if (found.mcp.status === 403) return refused("origin_refused");
  if (found.auth === "none") return { web: true, reason: null };
  if (
    found.mcp.status === 401 &&
    !found.mcp.wwwAuthenticate &&
    !found.resourceMetadata?.some((r) => r.ok && r.status === 200)
  )
    return refused("auth_header_hidden");
  if (!found.endpoints) {
    const blocked = found.authServerMetadata?.some((r) => !r.ok);
    return refused(blocked ? "auth_metadata_cors" : "auth_metadata_missing");
  }
  if (!found.s256) return refused("no_pkce");
  if (!found.endpoints.registration) return refused("no_registration");
  if (!found.registration?.ok) return refused("registration_cors");
  if (!found.token?.ok) return refused("token_cors");
  return { web: true, reason: null };
}

const { chromium: launcher } = await import(pathToFileURL(join(core, "index.mjs")).href);
const browser = await launcher.launch({ executablePath: chromium, headless: true });
const page = await browser.newPage();
await page.route(`${ORIGIN}/probe`, (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>probe</title>",
  }),
);
await page.goto(`${ORIGIN}/probe`);
const servers = {};
for (const entry of exported.catalog) {
  const found = await page.evaluate(probe, entry);
  found.registration = registrationAdmits(found.endpoints?.registration);
  if (found.registration && found.registrationFromTab?.ok) found.registration.ok = true;
  const origins = new Set([new URL(entry.url).origin]);
  // What the tab fetches; the authorization page is navigated to, not fetched.
  if (found.issuer) origins.add(new URL(found.issuer).origin);
  for (const url of [found.endpoints?.token, found.endpoints?.registration])
    if (url) origins.add(new URL(url).origin);
  servers[entry.id] = {
    ...verdict(found),
    // Every origin a tab would call for this server: the CSP's connect-src
    // must name each one for the server to work from /app.
    connect: [...origins].sort(),
    authorize: found.endpoints?.authorization ?? null,
    preflight: preflight(entry.url),
    steps: found,
  };
  process.stdout.write(
    `${entry.id}: ${servers[entry.id].web ? "web" : `no (${servers[entry.id].reason})`}\n`,
  );
}
await browser.close();
writeFileSync(
  join(root, "website/src/client/connectors/web-availability.json"),
  `${JSON.stringify({ probedAt: new Date().toISOString().slice(0, 10), origin: ORIGIN, browser: "Chromium headless shell 1234", servers }, null, 2)}\n`,
);
