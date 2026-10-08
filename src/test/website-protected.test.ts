// Protected mode in the web client (ADR-0084, held per browser): the adult
// model predicate and the quiet-hours window of the Rust tests, the PIN's
// hash and lockout, the switches behind the PIN, and the guards the page
// asks before anything leaves.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureStore } from "../../website/src/client/feature";
import { hashPin, pinMatches, Throttle, validPin } from "../../website/src/client/protected/pin";
import {
  guardsFor,
  isAdultModel,
  NO_RESTRICTIONS,
  PROTECTED,
  quietAt,
  validWindow,
  voiceRefusal,
  windowContains,
} from "../../website/src/client/protected/rules";
import { ProtectedMode } from "../../website/src/client/protected/state";
import { memoryClientStore } from "../../website/src/client/store";
import { vi } from "vitest";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const mode = (throttle = new Throttle()) =>
  new ProtectedMode(
    featureStore(ACCOUNT, new Uint8Array(32).fill(7), memoryClientStore(), "protected"),
    throttle,
    1000,
  );

describe("the rules Rust exports", () => {
  it("recognises adult families by id, name or trait", () => {
    for (const id of [
      "venice-uncensored",
      "lustify-sdxl",
      "Lustify-V8",
      "olafangensan-glm-4.7-flash-heretic",
      "abliteration-abliterated-model-large-v2",
      "some-nsfw-model",
    ])
      expect(isAdultModel(id)).toBe(true);
    expect(isAdultModel("qwen-3-6-plus", "Qwen 3.6 Plus Uncensored")).toBe(true);
    expect(isAdultModel("qwen-3-6-plus", "Qwen", ["most_uncensored"])).toBe(true);
    expect(isAdultModel("zai-org-glm-5-2", "GLM 5.2", ["tools"])).toBe(false);
  });

  it("reads a window within the day and one over midnight", () => {
    const day = { startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(windowContains(day, 9 * 60)).toBe(true);
    expect(windowContains(day, 17 * 60)).toBe(false);
    expect(windowContains(day, 8 * 60 + 59)).toBe(false);
    const night = { startMinute: 21 * 60, endMinute: 7 * 60 };
    expect(windowContains(night, 23 * 60)).toBe(true);
    expect(windowContains(night, 6 * 60 + 59)).toBe(true);
    expect(windowContains(night, 7 * 60)).toBe(false);
    expect(windowContains(night, 12 * 60)).toBe(false);
    expect(quietAt({ ...NO_RESTRICTIONS, quietHours: night }, 22 * 60)).toBe(true);
    expect(quietAt(NO_RESTRICTIONS, 22 * 60)).toBe(false);
  });

  it("refuses an empty or out-of-day window", () => {
    expect(validWindow({ startMinute: 60, endMinute: 60 })).toBe(false);
    expect(validWindow({ startMinute: 60, endMinute: 24 * 60 })).toBe(false);
    expect(validWindow({ startMinute: 21 * 60, endMinute: 7 * 60 })).toBe(true);
    expect(validWindow(undefined)).toBe(true);
  });
});

describe("the guards", () => {
  const models = [
    { id: "zai-org-glm-5-2", name: "GLM 5.2" },
    { id: "venice-uncensored", name: "Venice Uncensored" },
  ];

  it("let everything through while protected mode is off", () => {
    const guards = guardsFor(false, { ...NO_RESTRICTIONS, voiceOff: true });
    expect(guards.on).toBe(false);
    expect(guards.models(models)).toHaveLength(2);
    expect(guards.chatRefusal("venice-uncensored")).toBeNull();
    expect(guards.voice).toBe(true);
    expect(guards.promptBlock).toBeNull();
  });

  it("drop and refuse adult models and carry Rust's block while on", () => {
    const guards = guardsFor(true, NO_RESTRICTIONS, 12 * 60);
    expect(guards.models(models).map((model) => model.id)).toEqual(["zai-org-glm-5-2"]);
    expect(guards.chatRefusal("venice-uncensored")).toBe(PROTECTED.refusals.model);
    expect(guards.chatRefusal("zai-org-glm-5-2")).toBeNull();
    expect(guards.promptBlock).toBe(PROTECTED.promptBlock);
    expect(guards.promptBlock).toContain("Protected mode");
  });

  it("pause chat and voice in quiet hours, and hold each switch", () => {
    const restrictions = {
      quietHours: { startMinute: 21 * 60, endMinute: 7 * 60 },
      memoryOff: true,
      mediaOff: true,
      voiceOff: false,
      pastChatsOff: true,
    };
    const night = guardsFor(true, restrictions, 22 * 60);
    expect(night.chatRefusal("zai-org-glm-5-2")).toBe(PROTECTED.refusals.quietHours);
    expect(night.voice).toBe(false);
    expect(voiceRefusal(night)).toBe(PROTECTED.refusals.quietHours);
    const noon = guardsFor(true, restrictions, 12 * 60);
    expect(noon.chatRefusal("zai-org-glm-5-2")).toBeNull();
    expect(noon.memory).toBe(false);
    expect(noon.media).toBe(false);
    expect(noon.pastChats).toBe(false);
    expect(noon.voice).toBe(true);
    const voiceOff = guardsFor(true, { ...NO_RESTRICTIONS, voiceOff: true }, 12 * 60);
    expect(voiceRefusal(voiceOff)).toBe(PROTECTED.refusals.voiceOff);
  });
});

describe("the PIN", () => {
  it("is four to six digits", () => {
    for (const pin of ["1234", "123456"]) expect(validPin(pin)).toBe(true);
    for (const pin of ["123", "1234567", "12a4", " 1234", ""]) expect(validPin(pin)).toBe(false);
  });

  it("is salted and matches only its PIN", async () => {
    const first = await hashPin("1234", 1000);
    const second = await hashPin("1234", 1000);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    expect(await pinMatches("1234", first)).toBe(true);
    expect(await pinMatches("1235", first)).toBe(false);
    expect(await pinMatches("1234", { ...first, hash: "AAAA" })).toBe(false);
    expect(await pinMatches("1234", { ...first, iterations: 1e9 })).toBe(false);
    expect(await pinMatches("1234", undefined)).toBe(false);
  });

  it("locks the next try for thirty seconds after five wrong ones", () => {
    const throttle = new Throttle();
    const start = 1_000_000;
    for (let index = 0; index < PROTECTED.pin.maxFailures; index++) {
      expect(throttle.allowed(start)).toBe(true);
      throttle.record(false, start);
    }
    expect(throttle.allowed(start + 29_000)).toBe(false);
    expect(throttle.allowed(start + 30_000)).toBe(true);
  });
});

describe("protected mode in this browser", () => {
  it("turns on with a PIN, keeps the switches behind it, and turns off with it", async () => {
    const protectedMode = mode();
    expect(await protectedMode.turnOn("12")).toEqual({
      ok: false,
      reason: PROTECTED.refusals.pinFormat,
    });
    expect(await protectedMode.turnOn("2468")).toEqual({ ok: true });
    const on = await protectedMode.load();
    expect(on.enabled).toBe(true);
    expect(on.pin?.algorithm).toBe("pbkdf2-sha256");

    const switches = {
      ...NO_RESTRICTIONS,
      voiceOff: true,
      quietHours: { startMinute: 1260, endMinute: 420 },
    };
    expect(await protectedMode.setRestrictions("1111", switches)).toEqual({
      ok: false,
      reason: PROTECTED.refusals.wrongPin,
    });
    expect(
      await protectedMode.setRestrictions("2468", {
        ...switches,
        quietHours: { startMinute: 60, endMinute: 60 },
      }),
    ).toEqual({ ok: false, reason: PROTECTED.refusals.quietHoursInvalid });
    expect(await protectedMode.setRestrictions("2468", switches)).toEqual({ ok: true });
    expect((await protectedMode.load()).restrictions.voiceOff).toBe(true);

    expect(await protectedMode.turnOff("0000")).toEqual({
      ok: false,
      reason: PROTECTED.refusals.wrongPin,
    });
    expect(await protectedMode.turnOff("2468")).toEqual({ ok: true });
    const off = await protectedMode.load();
    expect(off.enabled).toBe(false);
    expect(off.pin).toBeUndefined();
    // Kept, out of force, for the next time.
    expect(off.restrictions.voiceOff).toBe(true);
  });

  it("refuses every try during a lockout, even the right PIN", async () => {
    const protectedMode = mode(new Throttle());
    await protectedMode.turnOn("2468");
    for (let index = 0; index < PROTECTED.pin.maxFailures; index++)
      await protectedMode.turnOff("0000");
    expect(await protectedMode.turnOff("2468")).toEqual({
      ok: false,
      reason: PROTECTED.refusals.locked,
    });
    expect((await protectedMode.load()).enabled).toBe(true);
  });
});
