/**
 * A connector this tab cannot reach, run by one of the person's own apps
 * (ADR-0107, the port of `connectors/relay.rs`'s asking end).
 *
 * Sentry, Stripe, Zapier, monday.com and Cloudflare's documentation server
 * refuse a web page's origin; a custom server's origin may be one `/app`'s
 * policy does not name; Google, Microsoft and GitHub sign in with the app's
 * own client ids. The account service never proxies any of them (ADR-0104).
 * Instead:
 *
 * - an app whose owner switched relaying on files an **offer** per connector
 *   it is signed in to (`connector_relays`), with the tools it listed;
 * - this tab writes a **call** addressed to that device (`connector_errands`,
 *   an errand of ADR-0054): the tool, its arguments, and whether the person
 *   already approved it here;
 * - that device applies its own rules, makes the call and writes the bounded
 *   result into the same row, which comes back here through synchronisation.
 *
 * The device's rules win: a tool it denies is declined, and one it asks
 * about comes back as `ask`, which this tab turns into the approval card. A
 * device that is closed answers nothing; after the wait the tab says which
 * device has to be open, and a late answer still reaches the call's card.
 */
import { t } from "../../lib/i18n";
import { encode } from "../../lib/vault";
import { type Row, timestamp, travellingRow } from "../codec";
import type { SyncClient } from "../sync";
import { type CallRecord, callKey, updateCall } from "./calls";
import { type ToolInfo, toolInfo } from "./mcp";
import { parseRule, type Rule } from "./rules";
import type { ConnectorEnv } from "./runtime";
import { CONNECTORS, fill } from "./words";

export interface Offer {
  id: string;
  deviceId: string;
  /** `computer` or `phone`: what the device is, which the page translates. */
  deviceName: string;
  connectorId: string;
  connectorName: string;
  /** What the device listed, each with the rule the device applies. The
   * offer is all a tab knows of the connector: its definition row may not
   * be on this browser. */
  tools: OfferedTool[];
  updatedAt: string;
}

export type OfferedTool = ToolInfo & { rule: Rule };

export type ErrandState = "requested" | "ask" | "done" | "failed" | "declined";

export interface RelayResult {
  text: string;
  links: { title: string; url: string }[];
  isError: boolean;
  /** Small structured content (a calendar's events), when the call had it. */
  structured?: unknown;
}

/** A settled call, as the device that made it wrote it. */
export type Answer =
  | { state: "done"; result: RelayResult }
  | { state: "ask" }
  | { state: "failed" | "declined"; message: string };

export class RelayError extends Error {
  constructor(public code: "too_large" | "no_device") {
    super(code);
  }
}

export const RELAY = CONNECTORS.relay;

function parseTools(raw: unknown): OfferedTool[] {
  if (typeof raw !== "string") return [];
  try {
    const listed: unknown = JSON.parse(raw);
    if (!Array.isArray(listed)) return [];
    return listed
      .map((entry): OfferedTool | null => {
        const info = toolInfo(entry);
        if (!info || !entry || typeof entry !== "object") return null;
        // The device sends its own reading of the hints and its rule.
        const hints = entry as { readOnly?: unknown; destructive?: unknown; rule?: unknown };
        const rule = parseRule(hints.rule) ?? (hints.readOnly === true ? "allow" : "ask");
        if (rule === "deny") return null;
        return {
          ...info,
          readOnly: hints.readOnly === true,
          destructive: hints.destructive === true,
          uiResource: null,
          rule,
        };
      })
      .filter((tool): tool is OfferedTool => tool !== null);
  } catch {
    return [];
  }
}

/** Every offer on the account, as the devices filed them. */
export function offers(sync: SyncClient): Offer[] {
  return sync.rows("connector_relays").map((object) => ({
    id: String(object.row.id),
    deviceId: String(object.row.device_id ?? ""),
    deviceName: String(object.row.device_name ?? ""),
    connectorId: String(object.row.connector_id ?? ""),
    connectorName: String(object.row.connector_name ?? ""),
    tools: parseTools(object.row.tools),
    updatedAt: String(object.row.updated_at ?? ""),
  }));
}

/** One offer per connector, the device that would run it (`offerFor`). */
export function relayedConnectors(sync: SyncClient, selfDeviceId: string | null = null): Offer[] {
  const ids = [...new Set(offers(sync).map((offer) => offer.connectorId))];
  return ids
    .map((id) => offerFor(sync, id, selfDeviceId))
    .filter((offer): offer is Offer => offer !== null)
    .sort((a, b) => a.connectorName.localeCompare(b.connectorName));
}

/** The device that runs a connector for this tab: a computer before a
 * phone (a phone answers only in the foreground), then the latest offer.
 * Never this browser itself. */
export function offerFor(
  sync: SyncClient,
  connectorId: string,
  selfDeviceId: string | null = null,
): Offer | null {
  const rank = (offer: Offer) => (offer.deviceName === "phone" ? 1 : 0);
  return (
    offers(sync)
      .filter(
        (offer) =>
          offer.connectorId === connectorId &&
          offer.deviceId !== selfDeviceId &&
          offer.tools.length > 0,
      )
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

/** What a device is, as the person reads it. */
export function deviceLabel(name: string): string {
  switch (name) {
    case "phone":
      return t("phone", "téléphone");
    case "browser":
      return t("browser", "navigateur");
    default:
      return t("computer", "ordinateur");
  }
}

/** What the model is told when the device did not answer: Rust's sentence,
 * with the device's kind in Rust's words. */
export function noAnswer(deviceName: string, connector: string): string {
  return fill(RELAY.sentences.noAnswer, {
    device: deviceName === "phone" ? "phone" : "computer",
    connector,
  });
}

/** A sentence a device wrote in a call's row, in the page's language when
 * it is one of the relay's own. */
export function messageText(message: string): string {
  const words = RELAY.sentences;
  switch (message) {
    case words.notAccepting:
      return t(
        "That device does not run connectors for your browser. In the app there, turn on “Run connectors for my browser” in Settings, Connectors.",
        "Cet appareil n’exécute pas les connecteurs pour votre navigateur. Dans l’app, activez « Exécuter les connecteurs pour mon navigateur » dans Réglages, Connecteurs.",
      );
    case words.tooLate:
      return t(
        "This call waited too long and was not made.",
        "Cet appel a attendu trop longtemps et n’a pas été fait.",
      );
    case words.notSignedIn:
      return t(
        "This connector is no longer signed in on that device.",
        "Ce connecteur n’est plus connecté sur cet appareil.",
      );
    case words.needsApproval:
      return t(
        "This action needs your approval before it runs.",
        "Cette action a besoin de votre accord avant de s’exécuter.",
      );
    case words.clockAhead:
      return t(
        "This call is dated ahead of that device's clock, so it was not made. Check this device's date and time.",
        "Cet appel est daté en avance sur l’horloge de cet appareil, il n’a donc pas été fait. Vérifiez la date et l’heure de cet appareil-ci.",
      );
    case words.badArguments:
      return t(
        "This call's arguments are not ones a tool takes, so it was not made.",
        "Les arguments de cet appel ne conviennent à aucun outil, il n’a donc pas été fait.",
      );
    case words.tooLarge:
      return t(
        "This call carries more than another device can take.",
        "Cet appel transporte plus qu’un autre appareil ne peut en recevoir.",
      );
    default:
      return message;
  }
}

/** JSON with every object's keys in order: the arguments a call carries,
 * written one way, so the approval signed over them names one text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner as Record<string, unknown>)
            .sort()
            .map((key) => [key, (inner as Record<string, unknown>)[key]]),
        )
      : inner,
  );
}

/** What an approval is of (`relay_approval::digest` in Rust): SHA-256 over
 * the tool's name, a NUL byte and the arguments exactly as the row carries
 * them, in base64url. */
export async function approvalDigest(tool: string, argumentsText: string): Promise<string> {
  const encoder = new TextEncoder();
  const name = encoder.encode(tool);
  const args = encoder.encode(argumentsText);
  const bytes = new Uint8Array(name.length + 1 + args.length);
  bytes.set(name, 0);
  bytes.set(args, name.length + 1);
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Writes a call addressed to the offer's device, and sends it at once. An
 * approved call carries this browser's signature over it in `message`: the
 * device runs an action that asks only on that (ADR-0107 addendum). */
export async function requestCall(
  sync: SyncClient,
  input: {
    offer: Offer;
    tool: string;
    args: Record<string, unknown>;
    approved: boolean;
    requestedBy: string;
    signApproval?: (claims: object) => Promise<string | null>;
  },
): Promise<string> {
  const argumentsText = canonicalJson(input.args ?? {});
  if (new TextEncoder().encode(argumentsText).length > RELAY.maxArgumentBytes)
    throw new RelayError("too_large");
  const id = crypto.randomUUID();
  const now = timestamp();
  const approval =
    input.approved && input.signApproval
      ? await input
          .signApproval({
            eid: id,
            dig: await approvalDigest(input.tool, argumentsText),
            iat: Math.floor(Date.now() / 1000),
          })
          .catch(() => null)
      : null;
  const row: Row = travellingRow("connector_errands", {
    id,
    device_id: input.offer.deviceId,
    connector_id: input.offer.connectorId,
    tool: input.tool,
    arguments: argumentsText,
    approved: input.approved ? 1 : 0,
    requested_by: input.requestedBy,
    requested_at: now,
    state: "requested",
    result: null,
    message: approval,
    updated_at: now,
  });
  await sync.write("connector_errands", row);
  // Offline, the call waits in the outbox and the wait below says so.
  await sync.flush().catch(() => undefined);
  return id;
}

function parseResult(raw: unknown): RelayResult {
  try {
    const value = JSON.parse(String(raw)) as Partial<RelayResult>;
    return {
      text: typeof value.text === "string" ? value.text : "",
      links: Array.isArray(value.links)
        ? value.links.filter(
            (link): link is { title: string; url: string } =>
              typeof link?.title === "string" && typeof link?.url === "string",
          )
        : [],
      isError: value.isError === true,
      ...(value.structured !== undefined ? { structured: value.structured } : {}),
    };
  } catch {
    return { text: "", links: [], isError: false };
  }
}

/** The call's answer, or null while it waits (or is gone). */
export function answerOf(sync: SyncClient, id: string): Answer | null {
  const object = sync.object("connector_errands", id);
  if (!object || object.deleted) return null;
  const state = String(object.row.state ?? "requested") as ErrandState;
  if (state === "done") return { state, result: parseResult(object.row.result) };
  if (state === "ask") return { state };
  if (state === "failed" || state === "declined")
    return { state, message: String(object.row.message ?? "") };
  return null;
}

export interface WaitOptions {
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
  /** Tests pass their own clock. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let timing: Pick<WaitOptions, "pollMs" | "sleep" | "waitMs"> = {};
/** Tests replace the clock the waits use. */
export function configureRelayTiming(given: Pick<WaitOptions, "pollMs" | "sleep" | "waitMs">) {
  timing = { ...given };
}

/** Waits for the device's answer while the tab is open: pulls the errands
 * every few seconds, up to the relay's wait. */
export async function waitForAnswer(
  sync: SyncClient,
  id: string,
  options: WaitOptions = {},
): Promise<Answer | "timeout"> {
  const waitMs = options.waitMs ?? timing.waitMs ?? RELAY.waitSeconds * 1000;
  const pollMs = options.pollMs ?? timing.pollMs ?? 2_500;
  const sleep = options.sleep ?? timing.sleep ?? defaultSleep;
  for (let waited = 0; ; waited += pollMs) {
    if (options.signal?.aborted) return "timeout";
    await sync.flush(options.signal).catch(() => undefined);
    await sync.pull(options.signal, ["errand"]).catch(() => undefined);
    const answer = answerOf(sync, id);
    if (answer) return answer;
    if (waited >= waitMs) return "timeout";
    await sleep(pollMs);
  }
}

/** Removes a settled call from the account: it was a question, not a
 * record. Best effort. */
export async function forget(sync: SyncClient, id: string) {
  const object = sync.object("connector_errands", id);
  if (!object || object.deleted) return;
  await sync.write("connector_errands", object.row, { deleted: true });
  await sync.flush().catch(() => undefined);
}

/** Whether a call that never got its answer may be dropped now. */
export function abandoned(sync: SyncClient, id: string, now = Date.now()): boolean {
  const object = sync.object("connector_errands", id);
  if (!object || object.deleted) return true;
  const at = Date.parse(String(object.row.requested_at ?? ""));
  return Number.isNaN(at) || now - at > (RELAY.expirySeconds + 60) * 1000;
}

// ── A call filed in this tab, made elsewhere ───────────────────────────────

export type RelayOutcome =
  | { kind: "done"; result: RelayResult }
  | { kind: "ask" }
  | { kind: "failed"; reason: string };

/**
 * Sends a filed call to the device that offers its connector, waits for the
 * answer and files it on the call. `approved` says the person approved it
 * here. A call nobody answered stays open: the next look (`reconcileRelayed`)
 * files a late answer on its card.
 */
export async function relayCall(
  env: ConnectorEnv,
  call: CallRecord,
  connectorName: string,
  approved: boolean,
  options: WaitOptions = {},
): Promise<RelayOutcome> {
  const offer = offerFor(env.sync, call.connectorId, env.deviceId ?? null);
  if (!offer) {
    await updateCall(env.store, call.id, {
      status: "failed",
      error: CONNECTORS.sentences.notOffered,
    });
    return { kind: "failed", reason: CONNECTORS.sentences.notOffered };
  }
  let errandId: string;
  try {
    errandId = await requestCall(env.sync, {
      offer,
      tool: call.tool,
      args: call.arguments,
      approved,
      requestedBy: env.deviceId ?? "browser",
      signApproval: env.signApproval,
    });
  } catch (error) {
    const reason =
      error instanceof RelayError && error.code === "too_large"
        ? RELAY.sentences.tooLarge
        : CONNECTORS.sentences.notOffered;
    await updateCall(env.store, call.id, { status: "failed", error: reason });
    return { kind: "failed", reason };
  }
  const relay = { deviceId: offer.deviceId, deviceName: offer.deviceName, errandId, closed: false };
  await updateCall(env.store, call.id, { status: "running", relay });
  const answer = await waitForAnswer(env.sync, errandId, options);
  if (answer === "timeout") {
    const reason = noAnswer(offer.deviceName, connectorName);
    await updateCall(env.store, call.id, { status: "failed", error: reason });
    return { kind: "failed", reason };
  }
  return settleCall(env, call.id, errandId, answer, relay);
}

async function settleCall(
  env: ConnectorEnv,
  callId: string,
  errandId: string,
  answer: Answer,
  relay: NonNullable<CallRecord["relay"]>,
): Promise<RelayOutcome> {
  const closed = { ...relay, closed: true };
  let outcome: RelayOutcome;
  if (answer.state === "done") {
    const { structured: _structured, ...result } = answer.result;
    await updateCall(env.store, callId, { status: "done", result, error: null, relay: closed });
    outcome = { kind: "done", result: answer.result };
  } else if (answer.state === "ask") {
    // The device's own rule asks: the card here asks the person, and an
    // approval sends a new call that says so.
    await updateCall(env.store, callId, { status: "pending", error: null, relay: closed });
    outcome = { kind: "ask" };
  } else {
    await updateCall(env.store, callId, {
      status: "failed",
      error: answer.message,
      relay: closed,
    });
    outcome = { kind: "failed", reason: answer.message };
  }
  await forget(env.sync, errandId).catch(() => undefined);
  return outcome;
}

/** Files the late answers of calls this tab stopped waiting for, drops the
 * ones nobody will answer any more, and removes from the account the calls
 * this browser asked that were settled and left (a research search that
 * timed out, a brief's calendar read). Run on the feature's minute tick. */
export async function reconcileRelayed(env: ConnectorEnv, now = Date.now()) {
  const calls = await env.store.list<CallRecord>("call:");
  for (const { value: call } of calls) {
    const relay = call.relay;
    if (!relay?.errandId || relay.closed) continue;
    const answer = answerOf(env.sync, relay.errandId);
    if (answer) {
      await settleCall(env, call.id, relay.errandId, answer, relay);
      continue;
    }
    if (abandoned(env.sync, relay.errandId, now)) {
      await env.store.put(callKey(call.id), { ...call, relay: { ...relay, closed: true } });
      await forget(env.sync, relay.errandId).catch(() => undefined);
    }
  }
  if (env.deviceId)
    for (const object of env.sync.rows("connector_errands")) {
      const id = String(object.row.id);
      if (object.row.requested_by !== env.deviceId || object.pending) continue;
      const settled = String(object.row.state ?? "requested") !== "requested";
      const at = Date.parse(String(object.row.updated_at ?? ""));
      if ((settled && now - at > 120_000) || abandoned(env.sync, id, now))
        await forget(env.sync, id).catch(() => undefined);
    }
}
